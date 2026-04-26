import {
    getChatMetadata,
    getSettings,
    initializeRequestMetadata,
    loadSettings,
    log,
    setChatMetadata,
    toastDebounced,
    updateConnectionProfileDropdown
} from './utils.js';
import {EXTENSION_NAME, EXTENSION_PATH, MODULE_NAME, VERSION} from './conf.js';
import {renderExtensionTemplateAsync} from "/scripts/extensions.js";
import {event_types} from "/scripts/events.js";
import {getCharacterCardFields, getMaxPromptTokens, messageFormatting} from "/script.js";
import {getWorldInfoPrompt} from "/scripts/world-info.js";

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
        const message = new SidePromptMessage();
        message.from_user = data.from_user;
        message.contents = data.contents;
        return message;
    }

    toJSON() {
        return {
            from_user: this.from_user,
            contents: this.contents
        };
    }

    static fromUser(val) {
        const message = new SidePromptMessage();
        message.from_user = true;
        message.contents = val;
        return message;
    }

    static fromAI(val) {
        const message = new SidePromptMessage();
        message.from_user = false;
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
        this.$element.find('.enerccio_sideprompt_message_copy').on('click', async () => {
            try {
                await navigator.clipboard.writeText(this.contents);
                log('Message copied to clipboard');
                toastDebounced('Message copied to clipboard');
            } catch (err) {
                console.error('Failed to copy text: ', err);
            }
        });
        $container.append(this.$element);
        this._update();
    }

    setText(text) {
        this.contents = text;
        if (this.$element) {
            this._update();
        }
    }

    async removeDiv() {
        this.$element.remove();
        this.$element = undefined;
    }

    _update() {
        this.$element.find('.enerccio_sideprompt_message_content')[0].innerHTML
            = messageFormatting(this.contents, "", false, false, -1);
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
            messages: this.messages.map(message => message.toJSON())
        };
    }

    async insertUserMessage(val) {
        const m = SidePromptMessage.fromUser(val);
        this.messages.push(m);
        await m.addTo(this.$container);
        await this.sidePrompt.save();

        await this.sidePrompt.generateReply();
    }

    async insertAIMessage(val) {
        const m = SidePromptMessage.fromAI(val);
        this.messages.push(m);
        await m.addTo(this.$container);
        await this.sidePrompt.save();
        return m;
    }

    getLastMessage() {
        return this.messages.length === 0 ? null : this.messages[this.messages.length - 1];
    }

    async insertMessages(prompts) {

        let {
            description,
            personality,
            persona,
            scenario,
            mesExamples,
            system,
            jailbreak,
            charDepthPrompt,
            creatorNotes,
        } = getCharacterCardFields();

        if (jailbreak) {
            prompts.push({
                content: jailbreak,
                role: "system",
            })
        }

        const firstMessage = getSettings("first_message");
        if (firstMessage) {
            prompts.push({
                content: firstMessage,
                role: "system",
            })
        }

        if (this.sidePrompt.includeScenario) {
            if (system)
                prompts.push({
                    content: scenario,
                    role: "system",
                });
            if (scenario)
                prompts.push({
                    content: scenario,
                    role: "system",
                });
        }

        if (this.sidePrompt.includePersona) {
            if (persona)
                prompts.push({
                    content: persona,
                    role: "system",
                });
        }

        if (this.sidePrompt.includeCharacters) {
            if (description)
                prompts.push({
                    content: description,
                    role: "system",
                });
            if (personality)
                prompts.push({
                    content: personality,
                    role: "system",
                });
            if (mesExamples)
                prompts.push({
                    content: mesExamples,
                    role: "system",
                });
        }

        if (this.sidePrompt.includeWorldinfo) {
            const globalScanData = {
                personaDescription: persona,
                characterDescription: description,
                characterPersonality: personality,
                characterDepthPrompt: charDepthPrompt,
                scenario: scenario,
                creatorNotes: creatorNotes,
                trigger: 'normal',
            };
            let this_max_context = getMaxPromptTokens();
            const { worldInfoString, worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth, outletEntries } =
                await getWorldInfoPrompt([], this_max_context, false, globalScanData);
            if (worldInfoBefore) {
                prompts.push({
                    content: worldInfoBefore,
                    role: "system",
                });
            }
            if (worldInfoAfter) {
                prompts.push({
                    content: worldInfoAfter,
                    role: "system",
                });
            }
        }

        this.messages.forEach(message => {
            prompts.push({
                content: message.contents,
                role: message.from_user ? "user" : "assistant",
            });
        });
    }

    async removeLast() {
        if (this.messages.length === 0) return null;
        const m = this.messages.pop();
        await m.removeDiv();
        return m;
    }

    async fromJson(chat) {
        this.messages.forEach(message => {
            message.removeDiv();
        })
        this.messages = [];
        if (chat.messages) {
            chat.messages.forEach(message => {
                const m = SidePromptMessage.fromJSON(message);
                m.addTo(this.$container);
                this.messages.push(m);
            })
        }
    }
}

class SidePrompt {

    constructor(root) {
        this.$contentPane = root;
        this.$root = $(`#${MODULE_NAME}_prompt_content`);
        this.$responseContainer = $(`#${MODULE_NAME}_prompt_response`);
        this.hidden = true;
        this.includePersona = false;
        this.$includePersona = $(`#${MODULE_NAME}_include_persona`);
        this.includeCharacters = false;
        this.$includeCharacters = $(`#${MODULE_NAME}_include_characters`);
        this.includeWorldinfo = false;
        this.$includeWorldinfo = $(`#${MODULE_NAME}_include_worldinfo`);
        this.includeScenario = false;
        this.$includeScenario = $(`#${MODULE_NAME}_include_scenario`);
        this.$userPrompt = $(`#${MODULE_NAME}_user_input`);
        this.$undo = $(`#${MODULE_NAME}_undo`);
        this.$send = $(`#${MODULE_NAME}_send`);
        this.$generateAgain = $(`#${MODULE_NAME}_generate_again`);
        this.container = new SidePromptContainer(this, this.$responseContainer);

        this.asyncGenerator = null;
        this.abort = null;
        this.loading = false;
    }

    async wire() {
        await this.updateButtonStates();

        this.$includePersona.on('change', async () => {
            if (this.loading) return;
            this.includePersona = !!this.$includePersona.prop('checked');
            await this.save();
        });

        this.$includeCharacters.on('change', async () => {
            if (this.loading) return;
            this.includeCharacters = !!this.$includeCharacters.prop('checked');
            await this.save();
        });

        this.$includeWorldinfo.on('change', async () => {
            if (this.loading) return;
            this.includeWorldinfo = !!this.$includeWorldinfo.prop('checked');
            await this.save();
        });

        this.$includeScenario.on('change', async () => {
            if (this.loading) return;
            this.includeScenario = !!this.$includeScenario.prop('checked');
            await this.save();
        });

        await this._setupAutoscroll();

        this.$send.on('click', async () => {
            const val = this.$userPrompt.val();
            if (val) {
                this.$userPrompt.val('');
                await this.container.insertUserMessage(val);
                this._scrollToBottom();
                await this.updateButtonStates();
            }
        });

        this.$undo.on('click', async () => {
            const m = await this.container.removeLast();
            this._scrollToBottom();
            if (m.from_user) {
                this.$userPrompt.val(m.contents);
            }
            await this.save();
            await this.updateButtonStates();
        });

        this.$generateAgain.on('click', async () => {
            await this.container.removeLast();
            this._scrollToBottom();
            await this.save();
            await this.updateButtonStates();
            await this.generateReply();
            await this.updateButtonStates();
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
        const saved = getChatMetadata("sidePrompt");
        if (saved) {
            this.loading = true;
            this.includePersona = saved.includePersona;
            this.includeScenario = saved.includeScenario;
            this.includeCharacters = saved.includeCharacters;
            this.includeWorldinfo = saved.includeWorldinfo;
            await this.container.fromJson(saved.chat);
            this.loading = false;

            this.$includePersona.prop('checked', this.includePersona);
            this.$includeCharacters.prop('checked', this.includeCharacters);
            this.$includeWorldinfo.prop('checked', this.includeWorldinfo);
            this.$includeScenario.prop('checked', this.includeScenario);
        }
        await this.updateButtonStates();
    }

    async save() {
        setChatMetadata("sidePrompt", {
            includePersona: this.includePersona,
            includeScenario: this.includeScenario,
            includeCharacters: this.includeCharacters,
            includeWorldinfo: this.includeWorldinfo,
            chat: this.container.toJSON(),
        }, true);
    }

    isGenerating() {
        return this.abort != null && !this.abort.signal.aborted;
    }

    async generateReply() {
        context.deactivateSendButtons();
        this.generatingActive = true;
        await this.updateButtonStates();

        const metadata = initializeRequestMetadata();
        this.abort = new AbortController();
        const profile = metadata.cId;
        let asyncGeneratorFunction = await context.ConnectionManagerRequestService.sendRequest(profile, await this.gatherPromptData(),
            profile.max_tokens, {stream: true, signal: this.abort.signal});
        const m = await this.container.insertAIMessage("");
        this.asyncGenerator = asyncGeneratorFunction();
        let text = "";
        try {
            while (true) {
                let r = await this.asyncGenerator.next();
                if (r.done) {
                    this.asyncGenerator = null;
                    this.abort = null;
                    this.generatingActive = false;
                    break;
                }

                const returnFromGenerator = r.value;
                text = returnFromGenerator.text;

                m.setText(text);
                await this.save();
            }
        } catch (aborted) {

        }
        context.activateSendButtons();
    }

    async gatherPromptData() {
        const prompts = [];

        await this.container.insertMessages(prompts);

        return prompts;
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

    async stIsGenerating(isGenerating) {
        this.generatingActive = isGenerating;
    }

    async updateButtonStates() {
        sidePrompt.$send.attr("disabled", this.generatingActive);
        sidePrompt.$generateAgain.attr("disabled", this.generatingActive || this.container.getLastMessage() == null ||
            this.container.getLastMessage().from_user);
        sidePrompt.$undo.attr("disabled", this.generatingActive || this.container.getLastMessage() == null);
    }

    async terminateIfGenerating() {
        if (this.isGenerating()) {
            this.abort.abort("userStopped");
            this.abort = null;
            this.asyncGenerator = null;
            await this.save();
        }
        await this.updateButtonStates();
    }

}

let sidePrompt;
let MESSAGE_TEMPLATE;

$(async function () {
    log('Loading extension...');

    await loadSettings();

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

    context.eventSource.on(event_types.GENERATION_STARTED, async () => {
        await sidePrompt.stIsGenerating(true);
    });

    context.eventSource.on(event_types.GENERATION_STOPPED, async () => {
        await sidePrompt.stIsGenerating(false);
        await sidePrompt.terminateIfGenerating();
    });

    context.eventSource.on(event_types.GENERATION_ENDED, async () => {
        await sidePrompt.stIsGenerating(false);
    });

    $button.on('click', async () => {
        log('Opened prompt');
        await sidePrompt.toggleVisibility();
        if (!sidePrompt.hidden) {
            await sidePrompt.load();
        }
    });

    let update_events = [event_types.PRESET_CHANGED, event_types.CONNECTION_PROFILE_LOADED, event_types.CONNECTION_PROFILE_UPDATED]
    for (let event of update_events) {
        context.eventSource.on(event, updateConnectionProfileDropdown);
    }
});
