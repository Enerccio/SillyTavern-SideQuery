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
import {getCharacterCardFields, getMaxQueryTokens, messageFormatting} from "/script.js";
import {getWorldInfoQuery} from "/scripts/world-info.js";

// eslint-disable-next-line no-undef
const $ = jQuery;
const context = SillyTavern.getContext();

class SideQueryMessage {

    constructor() {
        this.from_user = false;
        this.contents = "";
        this.$element = undefined;
    }

    static fromJSON(data) {
        const message = new SideQueryMessage();
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
        const message = new SideQueryMessage();
        message.from_user = true;
        message.contents = val;
        return message;
    }

    static fromAI(val) {
        const message = new SideQueryMessage();
        message.from_user = false;
        message.contents = val;
        return message;
    }

    async addTo($container) {
        this.$element = $(MESSAGE_TEMPLATE);
        this.$element.find('.enerccio_sidequery_message_sender').text(this.from_user ? "User" : "AI");
        if (this.from_user) {
            this.$element.addClass('enerccio_sidequery_message_left');
        } else {
            this.$element.addClass('enerccio_sidequery_message_right');
        }
        this.$element.find('.enerccio_sidequery_message_copy').on('click', async () => {
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
        this.$element.find('.enerccio_sidequery_message_content')[0].innerHTML
            = messageFormatting(this.contents, "", false, false, -1);
    }
}

class SideQueryContainer {

    constructor(sideQuery, $container) {
        this.sideQuery = sideQuery;
        this.messages = [];
        this.$container = $container;
    }

    toJSON() {
        return {
            messages: this.messages.map(message => message.toJSON())
        };
    }

    async insertUserMessage(val) {
        const m = SideQueryMessage.fromUser(val);
        this.messages.push(m);
        await m.addTo(this.$container);
        await this.sideQuery.save();

        await this.sideQuery.generateReply();
    }

    async insertAIMessage(val) {
        const m = SideQueryMessage.fromAI(val);
        this.messages.push(m);
        await m.addTo(this.$container);
        await this.sideQuery.save();
        return m;
    }

    getLastMessage() {
        return this.messages.length === 0 ? null : this.messages[this.messages.length - 1];
    }

    async insertMessages(queries) {

        let {
            description,
            personality,
            persona,
            scenario,
            mesExamples,
            system,
            jailbreak,
            charDepthQuery,
            creatorNotes,
        } = getCharacterCardFields();

        if (jailbreak) {
            queries.push({
                content: jailbreak,
                role: "system",
            })
        }

        const firstMessage = getSettings("first_message");
        if (firstMessage) {
            queries.push({
                content: firstMessage,
                role: "system",
            })
        }

        if (this.sideQuery.includeScenario) {
            if (system)
                queries.push({
                    content: scenario,
                    role: "system",
                });
            if (scenario)
                queries.push({
                    content: scenario,
                    role: "system",
                });
        }

        if (this.sideQuery.includePersona) {
            if (persona)
                queries.push({
                    content: persona,
                    role: "system",
                });
        }

        if (this.sideQuery.includeCharacters) {
            if (description)
                queries.push({
                    content: description,
                    role: "system",
                });
            if (personality)
                queries.push({
                    content: personality,
                    role: "system",
                });
            if (mesExamples)
                queries.push({
                    content: mesExamples,
                    role: "system",
                });
        }

        if (this.sideQuery.includeWorldinfo) {
            const globalScanData = {
                personaDescription: persona,
                characterDescription: description,
                characterPersonality: personality,
                characterDepthQuery: charDepthQuery,
                scenario: scenario,
                creatorNotes: creatorNotes,
                trigger: 'normal',
            };
            let this_max_context = getMaxQueryTokens();
            const { worldInfoString, worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth, outletEntries } =
                await getWorldInfoQuery([], this_max_context, false, globalScanData);
            if (worldInfoBefore) {
                queries.push({
                    content: worldInfoBefore,
                    role: "system",
                });
            }
            if (worldInfoAfter) {
                queries.push({
                    content: worldInfoAfter,
                    role: "system",
                });
            }
        }

        this.messages.forEach(message => {
            queries.push({
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
                const m = SideQueryMessage.fromJSON(message);
                m.addTo(this.$container);
                this.messages.push(m);
            })
        }
    }
}

class SideQuery {

    constructor(root) {
        this.$contentPane = root;
        this.$root = $(`#${MODULE_NAME}_query_content`);
        this.$responseContainer = $(`#${MODULE_NAME}_query_response`);
        this.hidden = true;
        this.includePersona = false;
        this.$includePersona = $(`#${MODULE_NAME}_include_persona`);
        this.includeCharacters = false;
        this.$includeCharacters = $(`#${MODULE_NAME}_include_characters`);
        this.includeWorldinfo = false;
        this.$includeWorldinfo = $(`#${MODULE_NAME}_include_worldinfo`);
        this.includeScenario = false;
        this.$includeScenario = $(`#${MODULE_NAME}_include_scenario`);
        this.$userQuery = $(`#${MODULE_NAME}_user_input`);
        this.$undo = $(`#${MODULE_NAME}_undo`);
        this.$send = $(`#${MODULE_NAME}_send`);
        this.$generateAgain = $(`#${MODULE_NAME}_generate_again`);
        this.container = new SideQueryContainer(this, this.$responseContainer);

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
            const val = this.$userQuery.val();
            if (val) {
                this.$userQuery.val('');
                await this.container.insertUserMessage(val);
                this._scrollToBottom();
                await this.updateButtonStates();
            }
        });

        this.$undo.on('click', async () => {
            const m = await this.container.removeLast();
            this._scrollToBottom();
            if (m.from_user) {
                this.$userQuery.val(m.contents);
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
        const saved = getChatMetadata("sideQuery");
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
        setChatMetadata("sideQuery", {
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
        let asyncGeneratorFunction = await context.ConnectionManagerRequestService.sendRequest(profile, await this.gatherQueryData(),
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

    async gatherQueryData() {
        const queries = [];

        await this.container.insertMessages(queries);

        return queries;
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
        sideQuery.$send.attr("disabled", this.generatingActive);
        sideQuery.$generateAgain.attr("disabled", this.generatingActive || this.container.getLastMessage() == null ||
            this.container.getLastMessage().from_user);
        sideQuery.$undo.attr("disabled", this.generatingActive || this.container.getLastMessage() == null);
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

let sideQuery;
let MESSAGE_TEMPLATE;

$(async function () {
    log('Loading extension...');

    await loadSettings();

    MESSAGE_TEMPLATE = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'message',
        { title: EXTENSION_NAME, version: VERSION }
    );

    const sideQueryTemplate = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'query',
        { title: EXTENSION_NAME, version: VERSION }
    );
    $('#movingDivs').append(sideQueryTemplate);
    const $sideQuery = $(`#${MODULE_NAME}_query`);
    sideQuery = new SideQuery($sideQuery);
    await sideQuery.wire();

    const $button = $(`<button class="${MODULE_NAME}_openButton menu_button interactable"><i class="fas fa-search"></i></button>'`)
    $('body').append($button);
    $button.attr('disabled', true);

    context.eventSource.on(event_types.CHAT_CHANGED, async () => {
        $button.attr('disabled', !context.getCurrentChatId());
        await sideQuery.hide();
    });

    context.eventSource.on(event_types.GENERATION_STARTED, async () => {
        await sideQuery.stIsGenerating(true);
    });

    context.eventSource.on(event_types.GENERATION_STOPPED, async () => {
        await sideQuery.stIsGenerating(false);
        await sideQuery.terminateIfGenerating();
    });

    context.eventSource.on(event_types.GENERATION_ENDED, async () => {
        await sideQuery.stIsGenerating(false);
    });

    $button.on('click', async () => {
        log('Opened query');
        await sideQuery.toggleVisibility();
        if (!sideQuery.hidden) {
            await sideQuery.load();
        }
    });

    let update_events = [event_types.PRESET_CHANGED, event_types.CONNECTION_PROFILE_LOADED, event_types.CONNECTION_PROFILE_UPDATED]
    for (let event of update_events) {
        context.eventSource.on(event, updateConnectionProfileDropdown);
    }
});
