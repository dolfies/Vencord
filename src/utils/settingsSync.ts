/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { showNotification } from "@api/Notifications";
import { PlainSettings } from "@api/Settings";
import { base64decode, base64encode } from "@protobuf-ts/runtime";
import { moment, RestAPI, Toasts } from "@webpack/common";
import { deflateSync, inflateSync } from "fflate";

import { TestUserSettings } from "../proto/TestUserSettings";
import { Logger } from "./Logger";
import { relaunch } from "./native";
import { chooseFile, saveFile } from "./web";

let protoSettings: TestUserSettings;

export async function importSettings(data: string) {
    try {
        var parsed = JSON.parse(data);
    } catch (err) {
        console.log(data);
        throw new Error("Failed to parse JSON: " + String(err));
    }

    if ("settings" in parsed && "quickCss" in parsed) {
        Object.assign(PlainSettings, parsed.settings);
        await VencordNative.settings.set(parsed.settings);
        await VencordNative.quickCss.set(parsed.quickCss);
    } else
        throw new Error("Invalid Settings. Is this even a Vencord Settings file?");
}

export async function exportSettings({ minify }: { minify?: boolean; } = {}) {
    const settings = VencordNative.settings.get();
    const quickCss = await VencordNative.quickCss.get();
    return JSON.stringify({ settings, quickCss }, null, minify ? undefined : 4);
}

export async function downloadSettingsBackup() {
    const filename = `vencord-settings-backup-${moment().format("YYYY-MM-DD")}.json`;
    const backup = await exportSettings();
    const data = new TextEncoder().encode(backup);

    if (IS_DISCORD_DESKTOP) {
        DiscordNative.fileManager.saveWithDialog(data, filename);
    } else {
        saveFile(new File([data], filename, { type: "application/json" }));
    }
}

const toast = (type: string, message: string) =>
    Toasts.show({
        type,
        message,
        id: Toasts.genId()
    });

const toastSuccess = () =>
    toast(Toasts.Type.SUCCESS, "Settings successfully imported. Restart to apply changes!");

const toastFailure = (err: any) =>
    toast(Toasts.Type.FAILURE, `Failed to import settings: ${String(err)}`);

export async function uploadSettingsBackup(showToast = true): Promise<void> {
    if (IS_DISCORD_DESKTOP) {
        const [file] = await DiscordNative.fileManager.openFiles({
            filters: [
                { name: "Vencord Settings Backup", extensions: ["json"] },
                { name: "all", extensions: ["*"] }
            ]
        });

        if (file) {
            try {
                await importSettings(new TextDecoder().decode(file.data));
                if (showToast) toastSuccess();
            } catch (err) {
                new Logger("SettingsSync").error(err);
                if (showToast) toastFailure(err);
            }
        }
    } else {
        const file = await chooseFile("application/json");
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async () => {
            try {
                await importSettings(reader.result as string);
                if (showToast) toastSuccess();
            } catch (err) {
                new Logger("SettingsSync").error(err);
                if (showToast) toastFailure(err);
            }
        };
        reader.readAsText(file);
    }
}

// Cloud settings
const cloudSettingsLogger = new Logger("Proto:Settings", "#39b7e0");

export function handleSettingsUpdate(data: string, force?: boolean, shouldNotify?: boolean) {
    const proto = unwrapProto(data);
    const oldVersion = PlainSettings.cloud.version;
    const newVersion = proto?.versions?.dataVersion ?? 0;

    if (!force && newVersion < oldVersion) {
        if (shouldNotify)
            showNotification({
                title: "Cloud Settings",
                body: "Your local settings are newer than the cloud ones.",
                noPersist: true,
            });
        return;
    }

    _handleSettingsUpdate(proto);
    cloudSettingsLogger.info(`Settings loaded from cloud successfully! Current version: ${protoSettings?.versions?.dataVersion}`);
    if (shouldNotify && newVersion > oldVersion)
        showNotification({
            title: "Cloud Settings",
            body: "Your settings have been updated! Click here to restart to fully apply changes!",
            color: "var(--green-360)",
            onClick: IS_WEB ? () => location.reload() : relaunch,
            noPersist: true
        });
    return newVersion > oldVersion;
}

function _handleSettingsUpdate(proto: TestUserSettings) {
    protoSettings = proto;
    importSettings(new TextDecoder().decode(inflateSync(proto.settings.vencord.data)));

    PlainSettings.cloud.version = proto?.versions?.dataVersion ?? 0;
    VencordNative.settings.set(PlainSettings);
}

export function unwrapProto(data: string) {
    return TestUserSettings.fromBinary(base64decode(data));
}

export function wrapProto(data: string) {
    if (!protoSettings)
        throw new Error("Settings not initialized");
    protoSettings.settings.vencord.data = deflateSync(new TextEncoder().encode(data));
    return base64encode(TestUserSettings.toBinary(protoSettings));
}

export async function putCloudSettings(manual?: boolean, requiredVersion?: number) {
    const settings = await exportSettings({ minify: true });
    const data = wrapProto(settings);

    try {
        const res = await RestAPI.patch(
            { url: "/users/@me/settings-proto/3", body: { settings: data, required_version: requiredVersion } }
        );

        if (!res.ok) {
            cloudSettingsLogger.error(`Failed to sync up, API returned ${res.status} ${res.body}`);
            showNotification({
                title: "Cloud Settings",
                body: `Could not synchronize settings to proto (API returned ${res.status}, error code ${res.body?.code}: ${res.body?.message}).`,
                color: "var(--red-360)"
            });
            return;
        }

        const { settings, out_of_date } = res.body;
        handleSettingsUpdate(settings);
        if (out_of_date) {
            cloudSettingsLogger.warn("Proto was out of date, discarding changes");
            return await putCloudSettings(manual);
        }

        cloudSettingsLogger.info("Settings uploaded successfully");

        if (manual) {
            showNotification({
                title: "Cloud Settings",
                body: "Synchronized settings to the cloud!",
                noPersist: true,
            });
        }
    } catch (e: any) {
        cloudSettingsLogger.error("Failed to sync up", e);
        showNotification({
            title: "Cloud Settings",
            body: `Could not synchronize settings to the cloud (${e.toString()}).`,
            color: "var(--red-360)"
        });
    }
}

export async function getCloudSettings(shouldNotify = true, force = false) {
    try {
        const res = await RestAPI.get({ url: "/users/@me/settings-proto/3" });
        if (!res.ok) {
            cloudSettingsLogger.error(`Failed to sync down, API returned ${res.status} ${res.body}`);
            showNotification({
                title: "Cloud Settings",
                body: `Could not synchronize settings from proto (API returned ${res.status}).`,
                color: "var(--red-360)"
            });
            return false;
        }

        return handleSettingsUpdate(res.body.settings, force, shouldNotify);
    } catch (e: any) {
        cloudSettingsLogger.error("Failed to sync down", e);
        showNotification({
            title: "Cloud Settings",
            body: `Could not synchronize settings from the cloud (${e.toString()}).`,
            color: "var(--red-360)"
        });

        return false;
    }
}

export async function deleteCloudSettings() {
    const data = wrapProto("");
    try {
        const res = await RestAPI.patch({ url: "/users/@me/settings-proto/3", body: { settings: data } });
        if (!res.ok) {
            cloudSettingsLogger.error(`Failed to delete cloud settings, API returned ${res.status} ${res.body}`);
            showNotification({
                title: "Cloud Settings",
                body: `Could not delete settings from proto (API returned ${res.status}).`,
                color: "var(--red-360)"
            });
            return;
        }

        cloudSettingsLogger.info("Settings deleted from cloud successfully");
        showNotification({
            title: "Cloud Settings",
            body: "Deleted settings from the cloud!",
            color: "var(--green-360)"
        });
    }
    catch (e: any) {
        cloudSettingsLogger.error("Failed to delete cloud settings", e);
        showNotification({
            title: "Cloud Settings",
            body: `Could not delete settings from the cloud (${e.toString()}).`,
            color: "var(--red-360)"
        });
    }
}
