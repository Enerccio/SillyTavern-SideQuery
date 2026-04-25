import { log } from './utils.js';
import {EXTENSION_NAME, EXTENSION_PATH, MODULE_NAME, VERSION} from './conf.js';
import {renderExtensionTemplateAsync} from "/scripts/extensions.js";
import {event_types} from "/scripts/events.js";
import {set_character_enabled_button_states} from "/scripts/extensions/third-party/SillyTavern-Reviewer/settings.js";

// eslint-disable-next-line no-undef
const $ = jQuery;
const context = SillyTavern.getContext();

class SidePromptMessage {

    constructor() {
        this.from_user = false;
        this.contents = "";
        this.$element = undefined;
    }

    static fromJSON(data) {
        return Object.assign(new this(), data);
    }

    static fromUser(val) {
        const message = new SidePromptMessage();
        message.from_user = true;
        message.contents = val;
        return message;
    }

    async addTo($container) {
        this.$element = $(MESSAGE_TEMPLATE);
        this.$element.find('.enerccio_sideprompt_message_sender').text(this.from_user ? "User" : "AI");
        if (this.from_user) {
            this.$element.addClass('enerccio_sideprompt_message_left');
        } else {
            this.$element.addClass('enerccio_sideprompt_message_right');
        }
        this.$element.find('.enerccio_sideprompt_message_content').text(this.contents);
        $container.append(this.$element);
    }
}

class SidePromptContainer {

    constructor(sidePrompt, $container) {
        this.sidePrompt = sidePrompt;
        this.messages = [];
        this.$container = $container;
    }

    toJSON() {
        return {
            messages: this.messages.map(message => JSON.stringify(message))
        };
    }

    async loadMessages(messages) {
        this.messages = messages.map(message => SidePromptMessage.fromJSON(JSON.parse(message)));
    }

    async insertUserMessage(val) {
        const m = SidePromptMessage.fromUser(val);
        this.messages.push(m);
        await m.addTo(this.$container, this.messages.length - 1);
        await this.sidePrompt.save();

        await this.sidePrompt.generateReply();
    }

    getLastMessage() {
        return this.messages.length === 0 ? null : this.messages[this.messages.length - 1];
    }
}

class SidePrompt {

    constructor(root) {
        this.$contentPane = root;
        this.$root = $(`#${MODULE_NAME}_prompt_content`);
        this.$responseContainer = $(`#${MODULE_NAME}_prompt_response`);
        this.hidden = true;
        this.includePersona = false;
        this.includeCharacters = false;
        this.includeWorldinfo = false;
        this.$userPrompt = $(`#${MODULE_NAME}_user_input`);
        this.$undo = $(`#${MODULE_NAME}_undo`);
        this.$send = $(`#${MODULE_NAME}_send`);
        this.$generateAgain = $(`#${MODULE_NAME}_generate_again`);
        this.container = new SidePromptContainer(this, this.$responseContainer);

        this.$undo.attr('disabled', true);
        this.$generateAgain.attr('disabled', true);
    }

    async wire() {
        $(`#${MODULE_NAME}_include_persona`).on('change', async () => {
            this.includePersona = $(this).is(':checked');
            await this.save();
        });

        $(`#${MODULE_NAME}_include_characters`).on('change', async () => {
            this.includeCharacters = $(this).is(':checked');
            await this.save();
        });

        $(`#${MODULE_NAME}_include_worldinfo`).on('change', async () => {
            this.includeWorldinfo = $(this).is(':checked');
            await this.save();
        });

        await this._setupAutoscroll();

        this.$send.on('click', async () => {
            const val = this.$userPrompt.val();
            if (val) {
                await this.container.insertUserMessage(val);
                this.$userPrompt.val('');
                this._scrollToBottom();
            }
        });
    }

    /**
     * sets up autoscroll for the content responses
     * @returns {Promise<void>}
     * @private
     */
    async _setupAutoscroll() {
        const scrollContainer = this.$responseContainer[0];
        const responseContainer = this.$responseContainer[0];
        let shouldAutoScroll = true;
        let scrollFrame = null;
        const bottomThreshold = 8;

        const isNearBottom = () => {
            const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
            return distanceFromBottom <= bottomThreshold;
        };

        const scrollToBottom = () => {
            if (!shouldAutoScroll) {
                return;
            }

            if (scrollFrame !== null) {
                cancelAnimationFrame(scrollFrame);
            }

            scrollFrame = requestAnimationFrame(() => {
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
                scrollFrame = null;
            });
        };
        this._scrollToBottom = () => {
            shouldAutoScroll = true;

            scrollFrame = requestAnimationFrame(() => {
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
                scrollFrame = null;
            });
        };

        scrollContainer.addEventListener('scroll', () => {
            shouldAutoScroll = isNearBottom();
        }, { passive: true });

        const resizeObserver = new ResizeObserver(() => {
            scrollToBottom();
        });

        resizeObserver.observe(responseContainer);

        const mutationObserver = new MutationObserver(() => {
            scrollToBottom();
        });

        mutationObserver.observe(responseContainer, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    async load() {

    }

    async save() {

    }

    async generateReply() {

    }

    async hide() {
        this.$contentPane.hide();
        this.hidden = true;
    }

    async toggleVisibility() {
        if (this.hidden) {
            this.$contentPane.show();
            this.hidden = false;
        } else {
            this.$contentPane.hide();
            this.hidden = true;
        }
    }

}

let sidePrompt;
let MESSAGE_TEMPLATE;

$(async function () {
    log('Loading extension...');

    MESSAGE_TEMPLATE = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'message',
        { title: EXTENSION_NAME, version: VERSION }
    );

    const sidePromptTemplate = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'prompt',
        { title: EXTENSION_NAME, version: VERSION }
    );
    $('#movingDivs').append(sidePromptTemplate);
    const $sidePrompt = $(`#${MODULE_NAME}_prompt`);
    sidePrompt = new SidePrompt($sidePrompt);
    await sidePrompt.wire();

    const $button = $(`<button class="${MODULE_NAME}_openButton menu_button interactable"><i class="fas fa-search"></i></button>'`)
    $('body').append($button);
    $button.attr('disabled', true);

    context.eventSource.on(event_types.CHAT_CHANGED, async () => {
        $button.attr('disabled', !context.getCurrentChatId());
        await sidePrompt.hide();
    });

    $button.on('click', async () => {
        log('Opened prompt');
        await sidePrompt.toggleVisibility();
        await sidePrompt.load();
    });
});
