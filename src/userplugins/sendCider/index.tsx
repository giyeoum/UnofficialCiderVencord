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

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import { closeModal, ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { Forms } from "@webpack/common";

import useAsyncMemo from "./hook";
import { CiderIcon } from "./icon";

export async function getCiderImages(type: string, token: string): Promise<string[]> {
    const data = await fetch("https://cider-api.cubiql.com/api/images/" + type, {
        headers: {
            "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({ token }),
    });

    const json = await data.json();

    return json.map(({ url }) => "https://cider-api.cubiql.com" + url);
}

const settings = definePluginSettings({
    token: {
        name: "사이다 API 토큰",
        description: "사이다 API 토큰을 입력하세요. (saintliy나 hyeo_ka에게 문의)",
        type: OptionType.STRING,
    },
    closeOnSend: {
        name: "보낼 때 모달 닫기",
        description: "사이다짤을 보낼 때 모달을 닫을지 여부",
        type: OptionType.BOOLEAN,
        default: true,
    }
});

function PickerModal({ rootProps, channel, close }: { rootProps: ModalProps, channel: Channel, close(): void; }) {
    const images = useAsyncMemo(async () => {
        if (!settings.store.token)
            throw new Error("사이다 API 토큰이 설정되지 않았습니다. 설정을 확인해주세요.");
        return await getCiderImages("image", settings.store.token);
    }, []);

    const { closeOnSend } = settings.store;

    return (
        <ModalRoot {...rootProps}>
            <ModalHeader >
                <Forms.FormTitle tag="h2">
                    사이다🍹짤 선택
                </Forms.FormTitle>

                <ModalCloseButton onClick={close} />
            </ModalHeader>

            <ModalContent className="cider-modal-content">
                {images && (images.map(image => (
                    <img
                        src={image}
                        alt="사이다짤"
                        key={image}
                        className="cider-image"
                        onClick={() => {
                            sendMessage(channel.id, {
                                content: image,
                                tts: false,
                            });
                            if (closeOnSend) close();
                        }}
                    />
                )))}
            </ModalContent>
        </ModalRoot>
    );
}

const ChatBarIcon: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip="Insert Cider"
            onClick={() => {
                const key = openModal(props => (
                    <PickerModal
                        rootProps={props}
                        channel={channel}
                        close={() => closeModal(key)}
                    />
                ));
            }}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            <CiderIcon
                aria-hidden="true"
                style={{ scale: "1.2" }}
            />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "SendCider",
    description: "사이다🍹짤을 쉽게 보내기!",
    authors: [{
        name: "Saintliy", id: 1296053433371066390n
    }],
    settings,

    renderChatBarButton: ChatBarIcon
});
