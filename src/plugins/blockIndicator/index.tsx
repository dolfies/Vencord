/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Tooltip } from "@webpack/common";

const classNames = findByPropsLazy("warningCircleIcon");

export default definePlugin({
    name: "BlockIndicator",
    description: "Displays an indicator on the profiles of people that have blocked you.",
    authors: [Devs.Dolfies],
    patches: [
        {
            // Users that have blocked you will have blanked profiles
            // We take advantage of this to save this information to the profile object
            find: "getUserProfile(",
            replacement: {
                match: /legacyUsername:(\i).legacy_username,/,
                replace: "$&hasBlocked:!$1.user_profile === null,",
            },
        }
    ],

    BlockedComponent() {
        `
        (0,
            l.jsx)(r.Tooltip, {
                text: P.default.Messages.USER_PROFILE_LOAD_ERROR,
                spacing: 20,
                color: r.TooltipColors.NESTED,
                children: e=>(0,
                l.jsx)(_.default, {
                    ...e,
                    className: y.warningCircleIcon,
                    color: n.default.unsafe_rawColors.YELLOW_300.css
                })
            })`;
        return <Tooltip text="This user has blocked you. What did you do :(" spacing={20} color="nested"
            children={props => <div {...props} className={classNames.warningCircleIcon} color="var(--red-300)" />} />;
    }
});
