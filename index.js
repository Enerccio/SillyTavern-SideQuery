import {
    error,
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
            let this_max_context = getMaxPromptTokens();
            const { worldInfoString, worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth, outletEntries } =
                await getWorldInfoPrompt([], this_max_context, false, globalScanData);
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

    constructor(parent, $root) {
        this.parent = parent;
        this.$root = $root;
        this.$responseContainer = this.$root.find(`.${MODULE_NAME}_response`);
        this.includePersona = false;
        this.$includePersona = this.$root.find(`.${MODULE_NAME}_include_persona`);
        this.includeCharacters = false;
        this.$includeCharacters = this.$root.find(`.${MODULE_NAME}_include_characters`);
        this.includeWorldinfo = false;
        this.$includeWorldinfo = this.$root.find(`.${MODULE_NAME}_include_worldinfo`);
        this.includeScenario = false;
        this.$includeScenario = this.$root.find(`.${MODULE_NAME}_include_scenario`);
        this.$userQuery = this.$root.find(`.${MODULE_NAME}_user_input`);
        this.$undo = this.$root.find(`.${MODULE_NAME}_undo`);
        this.$send = this.$root.find(`.${MODULE_NAME}_send`);
        this.$generateAgain = this.$root.find(`.${MODULE_NAME}_generate_again`);
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
            if (this.isGenerating()) {
                await this.terminateIfGenerating();
            } else {
                const val = this.$userQuery.val();
                if (val) {
                    this.$userQuery.val('');
                    await this.container.insertUserMessage(val);
                    this._scrollToBottom();
                    await this.updateButtonStates();
                }
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

    async load(saved) {
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
        await this.parent.saveTab({
            includePersona: this.includePersona,
            includeScenario: this.includeScenario,
            includeCharacters: this.includeCharacters,
            includeWorldinfo: this.includeWorldinfo,
            chat: this.container.toJSON()
        });
    }

    isGenerating() {
        return this.abort != null && !this.abort.signal.aborted;
    }

    async generateReply() {
        const metadata = initializeRequestMetadata();
        this.abort = new AbortController();
        await this.updateButtonStates();
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
                    break;
                }

                const returnFromGenerator = r.value;
                text = returnFromGenerator.text;

                m.setText(text);
                await this.save();
            }
        } catch (aborted) {
            if (aborted === 'userStopped') {
                log('Query generation aborted by user');
            } else {
                error("Query generation failed: " + aborted);
            }
            this.asyncGenerator = null;
            this.abort = null;
        }
        await this.updateButtonStates();
    }

    async gatherQueryData() {
        const queries = [];

        await this.container.insertMessages(queries);

        return queries;
    }

    async updateButtonStates() {
        this.$send.removeAttr("disabled");
        this.$send.text(this.isGenerating() ? 'STOP' : 'SEND');
        this.$generateAgain.attr("disabled", this.isGenerating() || this.container.getLastMessage() == null ||
            this.container.getLastMessage().from_user);
        this.$undo.attr("disabled", this.isGenerating() || this.container.getLastMessage() == null);
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

class SideQueryTabs {

    constructor($root) {
        this.$root = $root;
        this.$contentPane = this.$root.find(`#${MODULE_NAME}_query_content`);
        this.$tabdata = this.$root.find(`#${MODULE_NAME}_tabs_tabcontent`);
        this.$tabsContainer = this.$contentPane.find(`.${MODULE_NAME}_tabs`);
        this.$addTabBtn = this.$contentPane.find(`#${MODULE_NAME}_add_tab`);
        this.tabs = []
        this.activeTab = null;
        this.tabData = [];
        this.$addTabBtn.on('click', () => this.addNewTab());
    }

    isGenerating() {
        for (let tab of this.tabs) {
            if (tab.isGenerating()) {
                return true;
            }
        }
        return false;
    }

    tab() {
        return this.tabs.length > 0 ? this.tabs[this.activeTab] : undefined;
    }

    async hide() {
        this.$root.hide();
        this.hidden = true;
    }

    async toggleVisibility() {
        if (this.hidden) {
            this.$root.show();
            this.hidden = false;
        } else {
            this.$root.hide();
            this.hidden = true;
        }
    }

    async load() {
        this.$contentPane.find(`#${MODULE_NAME}_tabs_tabcontent`).children().remove();
        let saved = getChatMetadata("sideQuery");
        const meta = getChatMetadata("sideQueryMeta");
        if (saved) {
            if (saved.constructor === Object) {
                saved = [saved];
            }

            this.tabData = saved;
        }
        await this.updateTabs();
        if (meta) {
            const activeTab = meta.activeTab;
            if (activeTab !== null) {
                await this.onTabClicked(activeTab)
                this._scrollToActiveTab();
            }
        }
    }

    async saveTab(tabData) {
        if (this.activeTab !== null) {
            this.tabData[this.activeTab] = tabData;
        }
        await this.save();
    }

    async save() {
        setChatMetadata("sideQuery", this.tabData, true);
        setChatMetadata("sideQueryMeta", {
            activeTab: this.activeTab
        });
    }

    async clear() {
        this.tabs = [];
        this.tabData = [];
        this.activeTab = null;
        await this.updateTabs();
    }

    async updateTabs() {
        this.$tabsContainer.empty();

        for (let i = 0; i < this.tabData.length; i++) {
            const $tabBtn = $(`
                    <div class="${MODULE_NAME}_tabbtn ${i === this.activeTab ? 'active' : ''}" data-index="${i}">
                        <span>Tab ${i + 1}</span>
                        <i class="fas fa-times close-tab" title="Close Tab"></i>
                    </div>
                `);

            $tabBtn.on('click', (e) => {
                if (this.isGenerating())
                    return;
                if ($(e.target).hasClass('close-tab')) {
                    this.closeTab(i);
                } else {
                    this.onTabClicked(i);
                }
            });

            this.$tabsContainer.append($tabBtn);
        }

        if (this.tabs.length !== this.tabData.length) {
            await this.syncTabs();
        }
    }

    async syncTabs() {
        // Remove existing tab views
        this.tabs.forEach(t => t.$root?.remove());
        this.tabs = [];

        // Create new tab instances based on tabData
        for (let i = 0; i < this.tabData.length; i++) {
            const $tabRoot = $(QUERY_TEMPLATE).appendTo(this.$tabdata);
            const tab = new SideQuery(this, $tabRoot);
            await tab.wire();
            await tab.load(this.tabData[i]);
            this.tabs.push(tab);
        }

        this.$contentPane.find(`#${MODULE_NAME}_tabs_tabcontent`).children().hide();
        if (this.activeTab !== null && this.tabs[this.activeTab]) {
            this.showActiveTab();
        }
    }

    async addNewTab() {
        if (this.isGenerating())
            return;

        this.tabData.push({
            includePersona: false,
            includeScenario: false,
            includeCharacters: false,
            includeWorldinfo: false,
            chat: { messages: [] }
        });
        this.activeTab = this.tabData.length - 1;
        await this.updateTabs();
        await this.save();
    }

    async closeTab(index) {
        this.tabData.splice(index, 1);
        this.tabs.splice(index, 1);

        if (this.activeTab === index) {
            this.activeTab = this.tabData.length > 0 ? 0 : null;
        } else if (this.activeTab > index) {
            this.activeTab--;
        }

        await this.updateTabs();
        await this.save();
        await this.onTabClicked(this.activeTab);
    }

    async onTabClicked(index) {
        this.activeTab = index;
        await this.updateTabs();
        this.showActiveTab();
        this._scrollToActiveTab();
    }

    _scrollToActiveTab() {
        const $activeTabBtn = this.$tabsContainer.find(`.${MODULE_NAME}_tabbtn.active`);
        if ($activeTabBtn.length) {
            const container = this.$tabsContainer[0];
            const tabBtn = $activeTabBtn[0];

            const scrollLeft = tabBtn.offsetLeft - (container.clientWidth / 2) + (tabBtn.clientWidth / 2);
            container.scrollTo({
                left: scrollLeft,
                behavior: 'smooth'
            });
        }
    }

    showActiveTab() {
        this.$contentPane.find(`#${MODULE_NAME}_tabs_tabcontent`).children().hide();
        if (this.activeTab !== null && this.tabs[this.activeTab]) {
            this.tabs[this.activeTab].$root.show();
        }
    }

}

let sideQueryTabs;
let QUERY_TEMPLATE;
let MESSAGE_TEMPLATE;

$(async function () {
    log('Loading extension...');

    await loadSettings();

    MESSAGE_TEMPLATE = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'message',
        { title: EXTENSION_NAME, version: VERSION }
    );

    const tabs = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'tabs',
        { title: EXTENSION_NAME, version: VERSION }
    );

    QUERY_TEMPLATE = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'query',
        { title: EXTENSION_NAME, version: VERSION }
    );
    $('#movingDivs').append(tabs);
    const $sideQuery = $(`#${MODULE_NAME}_query`);
    sideQueryTabs = new SideQueryTabs($sideQuery);

    const $button = $(`<button class="${MODULE_NAME}_openButton menu_button interactable"><i class="fas fa-search"></i></button>'`)
    $('body').append($button);
    $button.attr('disabled', true);

    context.eventSource.on(event_types.CHAT_CHANGED, async () => {
        $button.attr('disabled', !context.getCurrentChatId());
        await sideQueryTabs.hide();
    });

    $button.on('click', async () => {
        log('Opened query');
        await sideQueryTabs.toggleVisibility();
        if (!sideQueryTabs.hidden) {
            await sideQueryTabs.clear();
            await sideQueryTabs.load();
        } else {
            await sideQueryTabs.save();
        }
    });

    let update_events = [event_types.PRESET_CHANGED, event_types.CONNECTION_PROFILE_LOADED, event_types.CONNECTION_PROFILE_UPDATED]
    for (let event of update_events) {
        context.eventSource.on(event, updateConnectionProfileDropdown);
    }
});
