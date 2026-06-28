import {
    countTokens,
    error,
    getChatMetadata,
    getSettings,
    initializeRequestMetadata,
    loadSettings,
    log,
    setChatMetadata,
    setSettings,
    toastDebounced,
    updateConnectionProfileDropdown
} from './utils.js';
import {EXTENSION_NAME, EXTENSION_PATH, MODULE_NAME, VERSION} from './conf.js';
import {getContext, renderExtensionTemplateAsync} from "/scripts/extensions.js";
import {event_types} from "/scripts/events.js";
import {getCharacterCardFields, getMaxPromptTokens, messageFormatting, substituteParams} from "/script.js";
import {getWorldInfoPrompt} from "/scripts/world-info.js";

const TRIGGER_KEYWORD = 'SIDEQUERY_TRIGGER';

// eslint-disable-next-line no-undef
const $ = jQuery;
const context = SillyTavern.getContext();

function ensureHtml2PdfLoaded() {
    return new Promise((resolve, reject) => {
        if (window.html2pdf) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
        script.onload = () => resolve();
        script.onerror = (err) => reject(err);
        document.head.appendChild(script);
    });
}

class SideQueryMessage {

    constructor() {
        this.from_user = false;
        this.contents = "";
        this.reasoning = "";
        this.reasoningFinished = false;
        this.reasoningTime = undefined;
        this.$element = undefined;
        this.included = true;
        this.genInfoText = "";
        this._updateTimeout = null;
    }

    static fromJSON(data) {
        const message = new SideQueryMessage();
        message.from_user = data.from_user;
        message.contents = data.contents;
        message.reasoning = data.reasoning;
        message.reasoningTime = data.reasoningTime;
        message.reasoningFinished = data.reasoningFinished;
        message.included = data.included !== undefined ? data.included : true;
        message.genInfoText = data.genInfoText || "";
        return message;
    }

    toJSON() {
        return {
            from_user: this.from_user,
            contents: this.contents,
            reasoning: this.reasoning,
            reasoningTime: this.reasoningTime,
            reasoningFinished: this.reasoningFinished,
            included: this.included,
            genInfoText: this.genInfoText,
        };
    }

    static fromUser(val) {
        const message = new SideQueryMessage();
        message.from_user = true;
        message.contents = val;
        message.reasoning = undefined;
        message.included = true;
        message.genInfoText = "";
        return message;
    }

    static fromAI(val, reasoning, genInfoText = "") {
        const message = new SideQueryMessage();
        message.from_user = false;
        message.contents = val;
        message.reasoning = reasoning;
        message.included = true;
        message.genInfoText = genInfoText;
        return message;
    }

    async addTo($container, sideQueryInstance) {
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

        // Anchor: Scroll until the bottom bounding line of this card is perfectly aligned with the screen container view
        this.$element.find('.enerccio_sidequery_message_scroll_bottom').on('click', (e) => {
            e.stopPropagation();
            this.$element[0].scrollIntoView({ behavior: 'smooth', block: 'end' });
        });

        // Anchor: Scroll until the top bounding line of this card snaps back to the view ceiling
        this.$element.find('.enerccio_sidequery_message_scroll_top').on('click', (e) => {
            e.stopPropagation();
            this.$element[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
        });

        // Wire up click event for the toggle eye button
        const $toggleBtn = this.$element.find('.enerccio_sidequery_message_toggle');
        $toggleBtn.on('click', async () => {
            this.included = !this.included;
            this._updateVisualState();
            if (sideQueryInstance) {
                await sideQueryInstance.save();
                await sideQueryInstance.updateTokenCount();
            }
        });

        // Wire up click event for the inline text editor button
        const $editBtn = this.$element.find('.enerccio_sidequery_message_edit');
        $editBtn.on('click', (e) => {
            if (sideQueryInstance && sideQueryInstance.isGenerating()) return;
            e.stopPropagation();

            const $contentContainer = this.$element.find('.enerccio_sidequery_message_content');

            // If already in editing state, ignore or toggle back
            if ($contentContainer.find('textarea').length > 0) return;

            const currentRawText = this.contents;
            const $textarea = $(`<textarea class="enerccio_sidequery_message_edit_input"></textarea>`).val(currentRawText);

            $contentContainer.empty().append($textarea);
            $textarea.focus();

            // Block input typing events from triggering parent shortcuts or layout drag handles
            $textarea.on('click mousedown mouseup keydown keyup', (ev) => {
                ev.stopPropagation();
            });

            const saveEditedMessage = async () => {
                this.contents = $textarea.val();

                // Redraw formatted message block node
                this._update();

                if (sideQueryInstance) {
                    await sideQueryInstance.save();
                    await sideQueryInstance.updateTokenCount();
                }
            };

            $textarea.on('blur', saveEditedMessage);
            $textarea.on('keydown', (ev) => {
                // Save on Ctrl+Enter or Cmd+Enter
                if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                    $textarea.off('blur'); // Bypass blur execution collision
                    saveEditedMessage();
                } else if (ev.key === 'Escape') {
                    $textarea.off('blur');
                    this._update(); // Restore old state
                }
            });
        });

        // --- PDF Filter Dropdown Controller Implementation ---
        const $pdfContainer = this.$element.find('.enerccio_sidequery_pdf_dropdown');
        const $pdfToggleBtn = $pdfContainer.find('.enerccio_sidequery_message_pdf_toggle');
        const $pdfMenu = $pdfContainer.find('.enerccio_sidequery_pdf_menu');

        // Toggle the dropdown layout open/closed on button click
        $pdfToggleBtn.on('click', (e) => {
            e.stopPropagation();
            // Close any other open export panels first
            $('.enerccio_sidequery_pdf_menu').not($pdfMenu).removeClass('show');
            $pdfMenu.toggleClass('show');
        });

        // Close the panel if the user clicks anywhere outside of it
        $(document).on('click.pdf-menu-hide', (e) => {
            if (!$(e.target).closest($pdfContainer).length) {
                $pdfMenu.removeClass('show');
            }
        });

        // Monitor selection routing hooks for custom layout choices
        $pdfMenu.find('.pdf-menu-item').on('click', async (e) => {
            e.stopPropagation();
            $pdfMenu.removeClass('show'); // Hide options bar

            if (!sideQueryInstance || !sideQueryInstance.container) return;

            const exportType = $(e.currentTarget).data('type');

            // Map criteria variables based on menu data tracking attributes
            const includeReasoning = exportType === 'complete' || exportType === 'no-user';
            const includeUserPrompts = exportType === 'complete' || exportType === 'no-reasoning';

            try {
                toastDebounced('Preparing your custom PDF export...', 'info');
                await ensureHtml2PdfLoaded();

                const allMessages = sideQueryInstance.container.messages;
                const targetIndex = allMessages.indexOf(this);
                if (targetIndex === -1) return;

                const $printArea = $('<div class="pdf-print-container" style="padding: 20px; font-family: sans-serif; display: flex; flex-direction: column; gap: 15px; color: #111; background: #fff;"></div>');

                const tabTitle = sideQueryInstance.name || "Side Query Session";
                $printArea.append(`<h2 style="border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 20px;">${tabTitle} - Exported History</h2>`);

                let itemsAddedCount = 0;

                for (let i = 0; i <= targetIndex; i++) {
                    const msg = allMessages[i];

                    // Filter check: Skip processing if user prompts are hidden
                    if (msg.from_user && !includeUserPrompts) continue;

                    itemsAddedCount++;
                    const senderLabel = msg.from_user ? "User" : "AI";
                    const bubbleBg = msg.from_user ? "#f0f4f8" : "#fbf8f3";
                    const borderLeftColor = msg.from_user ? "#7fb3e8" : "#4a341d";

                    const $msgBlock = $(`
                        <div style="padding: 12px; border-radius: 6px; background-color: ${bubbleBg}; border-left: 4px solid ${borderLeftColor}; margin-bottom: 10px; page-break-inside: avoid;">
                            <div style="font-weight: bold; font-size: 0.9em; color: #555; margin-bottom: 6px;">${senderLabel}</div>
                            <div style="white-space: pre-wrap; font-size: 1em; line-height: 1.4;"></div>
                        </div>
                    `);

                    $msgBlock.find('div:last-child').html(messageFormatting(msg.contents, "", false, false, -1));

                    // Filter check: Render reasoning metadata blocks only if allowed
                    if (msg.reasoning && includeReasoning && !msg.from_user) {
                        const $reasoningBlock = $(`
                            <div style="margin-top: 8px; padding: 8px; font-size: 0.85em; background: #f5f5f5; border-radius: 4px; color: #666; font-style: italic;">
                                <strong>Thought Process:</strong><br/>
                                ${messageFormatting(msg.reasoning, "", false, false, -1)}
                            </div>
                        `);
                        $msgBlock.append($reasoningBlock);
                    }

                    $printArea.append($msgBlock);
                }

                // Guard constraint: Abort file rendering if criteria leaves document empty
                if (itemsAddedCount === 0) {
                    toastDebounced('Export aborted: Selected filter criteria results in an empty layout document.', 'warning');
                    return;
                }

                $('body').append($printArea);

                const options = {
                    margin:       10,
                    filename:     `${tabTitle.toLowerCase().replace(/\s+/g, '_')}_history.pdf`,
                    image:        { type: 'jpeg', quality: 0.98 },
                    html2canvas:  { scale: 2, useCORS: true, logging: false },
                    jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
                };

                await html2pdf().set(options).from($printArea[0]).save();
                $printArea.remove();
                toastDebounced('PDF exported successfully!', 'success');

            } catch (err) {
                console.error("PDF generation pipeline encountered a rendering problem", err);
                toastDebounced('Failed to export PDF.', 'error');
            }
        });
        // -----------------------------------------------------

        $container.append(this.$element);
        this._update();
        this._updateVisualState();
    }

    _triggerThrottledUpdate() {
        if (!this.$element) return;
        // If a rendering cycle is already scheduled, don't flood the engine
        if (this._updateTimeout) return;

        this._updateTimeout = setTimeout(() => {
            this._update();
            this._updateTimeout = null;
        }, 150); // Cap layout recalculations to ~6 times a second max
    }

    forceUpdate() {
        if (this._updateTimeout) {
            clearTimeout(this._updateTimeout);
            this._updateTimeout = null;
        }
        this._update();
    }

    _updateVisualState() {
        if (!this.$element) return;
        const $toggleBtn = this.$element.find('.enerccio_sidequery_message_toggle');
        const $icon = $toggleBtn.find('i');

        if (this.included) {
            this.$element.removeClass('excluded-context');
            $toggleBtn.removeClass('is-excluded').attr('title', 'Exclude from next prompt context');
            $icon.removeClass('fa-eye-slash').addClass('fa-eye');
        } else {
            this.$element.addClass('excluded-context');
            $toggleBtn.addClass('is-excluded').attr('title', 'Include in next prompt context');
            $icon.removeClass('fa-eye').addClass('fa-eye-slash');
        }
    }

    setText(text) {
        this.contents = text;
        this._triggerThrottledUpdate();
    }

    setReasoning(reasoning, reasoningTime, reasoningFinished) {
        this.reasoning = reasoning;
        if (!reasoningFinished)
            this.reasoningTime = reasoningTime;
        this.reasoningFinished = reasoningFinished;
        this._triggerThrottledUpdate();
    }

    async removeDiv() {
        if (this._updateTimeout) {
            clearTimeout(this._updateTimeout);
            this._updateTimeout = null;
        }
        if (this.$element) {
            this.$element.remove();
            this.$element = undefined;
        }
    }

    _update() {
        const contentEl = this.$element.find('.enerccio_sidequery_message_content')[0];

        const selection = window.getSelection();
        let savedSelection = null;

        if (selection && selection.rangeCount > 0 && contentEl.contains(selection.anchorNode)) {
            const range = selection.getRangeAt(0);

            const getOffset = (node, offset, container) => {
                let totalOffset = 0;
                const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
                while (walker.nextNode()) {
                    if (walker.currentNode === node) {
                        return totalOffset + offset;
                    }
                    totalOffset += walker.currentNode.textContent.length;
                }
                return totalOffset;
            };

            savedSelection = {
                start: getOffset(range.startContainer, range.startOffset, contentEl),
                end: getOffset(range.endContainer, range.endOffset, contentEl)
            };
        }

        contentEl.innerHTML = messageFormatting(this.contents, "", false, false, -1);

        // Render the generation context info block beneath the text layout
        const $infoDiv = this.$element.find('.enerccio_sidequery_message_generation_info');
        if (this.genInfoText && !this.from_user) {
            $infoDiv.text(this.genInfoText).show();
        } else {
            $infoDiv.hide();
        }

        if (savedSelection) {
            const setOffset = (container, targetOffset) => {
                const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
                let currentOffset = 0;
                while (walker.nextNode()) {
                    const nodeLength = walker.currentNode.textContent.length;
                    if (currentOffset + nodeLength >= targetOffset) {
                        return { node: walker.currentNode, offset: targetOffset - currentOffset };
                    }
                    currentOffset += nodeLength;
                }
                return { node: container, offset: container.childNodes.length };
            };

            try {
                const startPoint = setOffset(contentEl, savedSelection.start);
                const endPoint = setOffset(contentEl, savedSelection.end);

                const newRange = document.createRange();
                newRange.setStart(startPoint.node, startPoint.offset);
                newRange.setEnd(endPoint.node, endPoint.offset);

                selection.removeAllRanges();
                selection.addRange(newRange);
            } catch (e) {
                console.warn("Could not restore side query text selection safely during render append", e);
            }
        }

        const $reasoningDetails = this.$element.find('.mes_reasoning_details');
        const $reasoningContent = this.$element.find('.mes_reasoning');
        const $reasoningHeader = $reasoningDetails.find('.mes_reasoning_header');

        if (this.reasoning) {
            $reasoningDetails.show();
            $reasoningContent[0].innerHTML = messageFormatting(this.reasoning, "", false, false, -1);

            if (this.reasoningTime) {
                const seconds = (this.reasoningTime / 1000).toFixed(1);
                if (this.reasoningFinished)
                    $reasoningHeader.text(`Thought for ${seconds} seconds`);
                else
                    $reasoningHeader.text(`Thinking for ${seconds} seconds`);
            }
        } else {
            $reasoningDetails.hide();
        }
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

    async trash() {
        this.messages.forEach(m => m.removeDiv());
        this.messages = [];
    }

    async insertUserMessage(val) {
        const m = SideQueryMessage.fromUser(val);
        this.messages.push(m);
        await m.addTo(this.$container, this.sideQuery); // Added reference parameter
        await this.sideQuery.save();

        await this.sideQuery.generateReply();
    }

    async insertAIMessage(val) {
        let activeContexts = [];
        if (this.sideQuery.includePersona) activeContexts.push("Persona");
        if (this.sideQuery.includeCharacters) activeContexts.push("Characters");
        if (this.sideQuery.includeScenario) activeContexts.push("Scenario");
        if (this.sideQuery.includeWorldinfo) {
            const wiMode = this.sideQuery.triggerType === 'sidequery' ? "SideQuery WI" : "Normal WI";
            activeContexts.push(`Worldinfo (${wiMode})`);
        }
        if (this.sideQuery.macroExpand) {
            activeContexts.push("Macroexpand");
        }
        if (this.sideQuery.includeMessages) {
            let logLabel = `Messages ${this.sideQuery.messagesCount}-${this.sideQuery.messagesCountTo}`;
            if (this.sideQuery.includeActorNames) {
                logLabel += " (with Names)";
            }
            activeContexts.push(logLabel);
        }

        const contextSummary = activeContexts.length > 0
            ? `Generated using: ${activeContexts.join(', ')}`
            : "Generated using global context overrides only";

        const m = SideQueryMessage.fromAI(val, undefined, contextSummary);
        this.messages.push(m);
        await m.addTo(this.$container, this.sideQuery); // Added reference parameter
        await this.sideQuery.save();
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
                m.addTo(this.$container, this.sideQuery); // Added reference parameter
                this.messages.push(m);
            })
        }
    }

    getLastMessage() {
        return this.messages.length === 0 ? null : this.messages[this.messages.length - 1];
    }

    async countTokens() {
        const queries = [];
        await this.insertMessages(queries);
        let text = "";
        for (const query of queries) {
            text += query.content;
    }
        return await countTokens(text, 0);
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

        let chatMessagesData = "";
        if (this.sideQuery.includeMessages) {
            const count = this.sideQuery.messagesCount;
            const countTo = this.sideQuery.messagesCountTo;
            const chatMessages = getContext().chat;

            if (count <= countTo && count >= 0) {
                const targetMessages = chatMessages.slice(count, countTo + 1);

                const processingPromises = targetMessages.map(async (m) => {
                    if (!m) return "";

                    let msgText = (await window.enerccio_compat?.messageProcessor(
                        m.mes,
                        {
                            'role': m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'),
                            'content': m.mes
                        }
                    )) || m.mes;

                    if (this.sideQuery.includeActorNames) {
                        const speakerName = m.name || (m.is_user ? "User" : "AI");
                        msgText = `${speakerName}: ${msgText}`;
                    }

                    return msgText;
                });

                const resolvedMessages = await Promise.all(processingPromises);
                chatMessagesData = resolvedMessages.filter(Boolean).join("\n\n") + "\n\n";
            }
        }

        if (this.sideQuery.includeWorldinfo) {
            const globalScanData = {
                personaDescription: persona,
                characterDescription: description,
                characterPersonality: personality,
                characterDepthQuery: charDepthQuery,
                scenario: scenario,
                creatorNotes: creatorNotes,
                trigger: this.sideQuery.triggerType,
            };
            let this_max_context = getMaxPromptTokens();
            const {
                worldInfoString,
                worldInfoBefore,
                worldInfoAfter,
                worldInfoExamples,
                worldInfoDepth,
                outletEntries
            } = await getWorldInfoPrompt(chatMessagesData ? [chatMessagesData + `\n${TRIGGER_KEYWORD}`] : [ TRIGGER_KEYWORD ], this_max_context, false, globalScanData);

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

        // must be AFTER world info
        if (chatMessagesData) {
            queries.push({
                content: chatMessagesData,
                role: "system",
            });
        }

        const beforeLastMessage = getSettings("before_last_message");
        this.messages.forEach((message, index) => {
            if (index === this.messages.length - 1)
                if (beforeLastMessage) {
                    queries.push({
                        content: beforeLastMessage,
                        role: "system",
                    })
                }

            if (message.included) {
                let content = message.contents;
                if (this.sideQuery.macroExpand) {
                    if (message.from_user) {
                        content = substituteParams(content);
                    }
                }
                queries.push({
                    content: content,
                    role: message.from_user ? "user" : "assistant",
                });
            }
        });
    }

    async removeLast() {
        if (this.messages.length === 0) return null;
        const m = this.messages.pop();
        await m.removeDiv();
        return m;
    }

}

class SideQuery {

    constructor(parent, $root) {
        this.parent = parent;
        this.$root = $root;
        this.$responseContainer = this.$root.find(`.${MODULE_NAME}_response`);
        this.includePersona = false;
        this.includeCharacters = false;
        this.includeWorldinfo = false;
        this.macroExpand = true;
        this.triggerType = 'normal';
        this.includeScenario = false;
        this.includeMessages = false;
        this.includeActorNames = false;
        this.messagesCount = 5;
        this.messagesCountTo = 5;

        this.$userQuery = this.$root.find(`.${MODULE_NAME}_user_input`);
        this.$tokenCount = this.$root.find(`.${MODULE_NAME}_query_token_count`);
        this.$optionsToggle = this.$root.find('.enerccio_sidequery_options_menu_trigger');

        this.$undo = this.$root.find(`.${MODULE_NAME}_undo`);
        this.$send = this.$root.find(`.${MODULE_NAME}_send`);
        this.$generateAgain = this.$root.find(`.${MODULE_NAME}_generate_again`);

        this.$savedPrompts = this.$root.find(`.enerccio_sidequery_saved_prompts`);
        this.$saveBtn = this.$root.find(`.enerccio_sidequery_save`);
        this.$saveAsBtn = this.$root.find(`.enerccio_sidequery_save_as`);
        this.$deleteBtn = this.$root.find(`.enerccio_sidequery_delete`);

        this.container = new SideQueryContainer(this, this.$responseContainer);

        this.asyncGenerator = null;
        this.abort = null;
        this.loading = false;
        this.data = null;
        this.loaded = false;
        this.name = "";
        this.isManuallyRenamed = false;
    }

    bindGlobalOptions() {
        if (!$globalOptionsPopover) return;

        $globalOptionsPopover.find('input, select').off('.tabContext');

        $globalOptionsPopover.find('.enerccio_sidequery_include_persona').prop('checked', this.includePersona);
        $globalOptionsPopover.find('.enerccio_sidequery_include_characters').prop('checked', this.includeCharacters);
        $globalOptionsPopover.find('.enerccio_sidequery_include_worldinfo').prop('checked', this.includeWorldinfo);
        $globalOptionsPopover.find('.enerccio_sidequery_trigger_type').val(this.triggerType);
        $globalOptionsPopover.find('.enerccio_sidequery_include_scenario').prop('checked', this.includeScenario);
        $globalOptionsPopover.find('.enerccio_sidequery_macro_expand').prop('checked', this.macroExpand);
        $globalOptionsPopover.find('.enerccio_sidequery_include_messages').prop('checked', this.includeMessages);
        $globalOptionsPopover.find('.enerccio_sidequery_include_messages').prop('checked', this.includeMessages);
        $globalOptionsPopover.find('.enerccio_sidequery_include_actor_names').prop('checked', this.includeActorNames); // ADD THIS LINE
        $globalOptionsPopover.find('.enerccio_sidequery_messages_count_from').val(this.messagesCount);
        $globalOptionsPopover.find('.enerccio_sidequery_messages_count_from').val(this.messagesCount);
        $globalOptionsPopover.find('.enerccio_sidequery_messages_count_to').val(this.messagesCountTo);

        $globalOptionsPopover.find('.enerccio_sidequery_include_persona').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.includePersona = !!$(e.target).prop('checked');
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_include_characters').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.includeCharacters = !!$(e.target).prop('checked');
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_include_worldinfo').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.includeWorldinfo = !!$(e.target).prop('checked');
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_trigger_type').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.triggerType = $(e.target).val() || 'normal';
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_include_scenario').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.includeScenario = !!$(e.target).prop('checked');
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_macro_expand').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.macroExpand = !!$(e.target).prop('checked');
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_include_messages').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.includeMessages = !!$(e.target).prop('checked');
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_include_messages').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.includeMessages = !!$(e.target).prop('checked');
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_include_actor_names').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.includeActorNames = !!$(e.target).prop('checked');
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_messages_count_from').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.messagesCount = parseInt($(e.target).val(), 10) || 0;
            await this.save();
            await this.updateTokenCount();
        });
        $globalOptionsPopover.find('.enerccio_sidequery_messages_count_to').on('change.tabContext', async (e) => {
            if (this.loading) return;
            this.messagesCountTo = parseInt($(e.target).val(), 10) || 0;
            await this.save();
            await this.updateTokenCount();
        });
    }

    async wire() {
        await this.updateButtonStates();
        this.updateSavedQueriesDropdown();

        this.$optionsToggle.on('click', (e) => {
            e.stopPropagation();

            const $button = $(e.currentTarget);
            const $panel = $globalOptionsPopover;
            const isVisible = $panel.is(':visible');

            if (!isVisible) {
                this.bindGlobalOptions();

                $panel.css({ display: 'flex', visibility: 'hidden' });

                const rect = $button[0].getBoundingClientRect();
                const buttonTopViewport = rect.top;
                const buttonLeftViewport = rect.left;
                const toggleHeight = rect.height;
                const toggleWidth = rect.width;

                const panelHeight = $panel.outerHeight();
                const panelWidth = $panel.outerWidth();

                let leftPosition = buttonLeftViewport + toggleWidth + 6;
                let topPosition;

                if (buttonTopViewport + panelHeight <= $(window).height() - 10) {
                    topPosition = buttonTopViewport;
                    $panel.addClass('drop-down-mode');
                } else {
                    topPosition = buttonTopViewport + toggleHeight - panelHeight;
                    $panel.removeClass('drop-down-mode');
                }

                if (leftPosition + panelWidth > $(window).width() - 10) {
                    leftPosition = buttonLeftViewport - panelWidth - 6;
                }
                if (leftPosition < 10) leftPosition = 10;
                if (topPosition < 10) topPosition = 10;
                if (topPosition + panelHeight > $(window).height() - 10) {
                    topPosition = $(window).height() - panelHeight - 10;
                }

                $panel.css({ top: '', left: '' });

                $panel[0].style.setProperty('top', topPosition + 'px', 'important');
                $panel[0].style.setProperty('left', leftPosition + 'px', 'important');
                $panel[0].style.setProperty('display', 'flex', 'important');
                $panel[0].style.visibility = 'visible';

                $(document).off('click.options-popover-hide').on('click.options-popover-hide', (ev) => {
                    if (!$(ev.target).closest($button).length && !$(ev.target).closest($panel).length) {
                        $panel.hide();
                        $(document).off('click.options-popover-hide');
                    }
                });
            } else {
                $panel.hide();
                $(document).off('click.options-popover-hide');
            }
        });

        $globalOptionsPopover.off('click.prevent-bubble').on('click.prevent-bubble', (e) => {
            e.stopPropagation();
        });

        this.$userQuery.on('input', () => {
            this.checkIfPromptModified();
        });

        this.$savedPrompts.on('change', () => {
            this.$savedPrompts.find('option').each((idx, el) => {
                const val = $(el).val();
                if (val) {
                    $(el).text(val);
                }
            });

            const selected = this.$savedPrompts.val();
            if (selected) {
                const savedQueries = getSettings('saved_queries', false, {});
                if (savedQueries[selected] !== undefined) {
                    this.$userQuery.val(savedQueries[selected]);
                }
            }
        });

        this.$saveBtn.on('click', () => {
            const selected = this.$savedPrompts.val();
            const currentText = this.$userQuery.val();
            if (!currentText.trim()) {
                toastDebounced('Cannot save an empty query.');
                return;
            }
            if (selected) {
                const savedQueries = getSettings('saved_queries', true, {});
                savedQueries[selected] = currentText;
                setSettings('saved_queries', savedQueries);
                this.parent.updateAllSavedQueriesDropdowns();
                toastDebounced(`Overwrote saved query: ${selected}`);
            } else {
                this.showSaveAsPopover();
            }
        });

        this.$saveAsBtn.on('click', () => {
            const currentText = this.$userQuery.val();
            if (!currentText.trim()) {
                toastDebounced('Cannot save an empty query.');
                return;
            }
            this.showSaveAsPopover();
        });

        this.$deleteBtn.on('click', () => {
            const selected = this.$savedPrompts.val();
            if (!selected) {
                toastDebounced('Please select a saved query to delete.');
                return;
            }
            const savedQueries = getSettings('saved_queries', true, {});
            delete savedQueries[selected];
            setSettings('saved_queries', savedQueries);
            this.parent.updateAllSavedQueriesDropdowns();
            toastDebounced(`Deleted query: ${selected}`);
        });

        await this._setupAutoscroll();

        this.$send.on('click', async () => {
            if (this.isGenerating()) {
                await this.terminateIfGenerating();
            } else {
                const val = this.$userQuery.val();
                if (val) {
                    this.$userQuery.val('');

                    // Clear asterisks and reset
                    this.$savedPrompts.find('option').each((idx, el) => {
                        const val = $(el).val();
                        if (val) $(el).text(val);
                    });
                    this.$savedPrompts.val('');

                    await this.container.insertUserMessage(val);
                    this._scrollToBottom();
                    await this.updateButtonStates();
                }
            }
        });

        this.$undo.on('click', async () => {
            const lastMsg = this.container.getLastMessage();
            if (lastMsg && lastMsg.from_user) {
                // Clear asterisks and reset the selection before restoring input text
                this.$savedPrompts.find('option').each((idx, el) => {
                    const val = $(el).val();
                    if (val) $(el).text(val);
                });
                this.$savedPrompts.val('');
            }

            const m = await this.container.removeLast();
            this._scrollToBottom();
            if (m && m.from_user) {
                this.$userQuery.val(m.contents);
            }

            // Regenerate the tab name ONLY if it wasn't manually customized by the user
            if (!this.isManuallyRenamed && this.container.messages.length < 2) {
                const tabIndex = this.parent.tabs.indexOf(this);
                const defaultName = `Tab ${tabIndex + 1}`;
                this.name = defaultName;
                await this.save();
                await this.parent.renameTab(this, defaultName);
            } else {
                await this.save();
            }

            await this.updateButtonStates();
            await this.updateTokenCount();
        });

        this.$generateAgain.on('click', async () => {
            await this.container.removeLast();
            this._scrollToBottom();
            await this.save();
            await this.updateButtonStates();
            await this.updateTokenCount();
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

        const isCurrentActiveTab = () => {
            if (!this.parent || typeof this.parent.tab !== 'function') return true;
            return this.parent.tab() === this;
        };

        const isNearBottom = () => {
            const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
            return distanceFromBottom <= bottomThreshold;
        };

        const scrollToBottom = () => {
            // CRITICAL FIX: If the parent tab container is clearing/rebuilding the DOM headers,
            // or if this is a background tab, completely ignore the scroll adjustments!
            if (this.parent && this.parent.isRebuildingLayout) {
                return;
            }

            if (!shouldAutoScroll || !isCurrentActiveTab()) {
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
            if (!isCurrentActiveTab() || (this.parent && this.parent.isRebuildingLayout)) return;

            shouldAutoScroll = true;

            scrollFrame = requestAnimationFrame(() => {
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
                scrollFrame = null;
            });
        };

        scrollContainer.addEventListener('scroll', () => {
            // Only adjust shouldAutoScroll if the layout isn't actively mutating structural headers
            if (this.parent && this.parent.isRebuildingLayout) return;
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
        this.saved = saved;
        this.loaded = false;
        this.name = saved?.name || "";
        this.isManuallyRenamed = saved?.isManuallyRenamed || false;
        this.scrollPosition = saved?.scrollPosition || 0;
        await this.updateButtonStates();
        await this.updateTokenCount();
    }

    async fill() {
        if (this.saved && !this.loaded) {
            this.loading = true;
            this.includePersona = this.saved.includePersona;
            this.includeScenario = this.saved.includeScenario;
            this.includeCharacters = this.saved.includeCharacters;
            this.includeWorldinfo = this.saved.includeWorldinfo;
            this.macroExpand = this.saved.macroExpand ?? true;
            this.triggerType = this.saved.triggerType ?? 'normal';
            this.includeMessages = this.saved.includeMessages ?? false;
            this.includeActorNames = this.saved.includeActorNames ?? false;
            this.messagesCount = this.saved.messagesCount ?? 0;
            this.messagesCountTo = this.saved.messagesCountTo ?? 5;
            this.name = this.saved.name || "";
            this.isManuallyRenamed = this.saved.isManuallyRenamed || false;
            await this.container.fromJson(this.saved.chat);
            this.loading = false;
            this.loaded = true;
        }

        this.bindGlobalOptions();
        this.updateSavedQueriesDropdown();
        await this.updateButtonStates();
        await this.updateTokenCount();
        this.restoreScrollPosition();
    }

    checkIfPromptModified() {
        const selected = this.$savedPrompts.val();
        if (!selected) return;

        const savedQueries = getSettings('saved_queries', false, {});
        const savedText = savedQueries[selected];
        if (savedText === undefined) return;

        const currentText = this.$userQuery.val();
        const $option = this.$savedPrompts.find(`option[value="${selected}"]`);

        if (currentText !== savedText) {
            if (!$option.text().endsWith(' *')) {
                $option.text(selected + ' *');
            }
        } else {
            $option.text(selected);
        }
    }

    updateSavedQueriesDropdown() {
        const savedQueries = getSettings('saved_queries', false, {});
        const currentValue = this.$savedPrompts.val();
        this.$savedPrompts.empty();
        this.$savedPrompts.append('<option value="">-- Select Saved Query --</option>');
        for (const name of Object.keys(savedQueries).sort()) {
            this.$savedPrompts.append($('<option></option>').val(name).text(name));
        }
        if (savedQueries[currentValue] !== undefined) {
            this.$savedPrompts.val(currentValue);
        } else {
            this.$savedPrompts.val('');
        }
    }

    showSaveAsPopover() {
        const $popover = this.$root.find('.enerccio_sidequery_popover');
        const $input = $popover.find('.enerccio_sidequery_popover_input');

        $input.val(this.$savedPrompts.val() || '');
        $popover.css('display', 'flex');
        $input.focus().select();

        $popover.off('click mousedown mouseup keydown keyup').on('click mousedown mouseup keydown keyup', (e) => {
            e.stopPropagation();
        });

        const closePopover = () => {
            $popover.hide();
            $popover.find('.enerccio_sidequery_popover_ok').off('click');
            $popover.find('.enerccio_sidequery_popover_cancel').off('click');
            $input.off('keydown');
        };

        const submitSaveAs = () => {
            const name = $input.val().trim();
            if (!name) {
                toastDebounced('Please enter a valid name.');
                return;
            }
            const currentText = this.$userQuery.val();
            const savedQueries = getSettings('saved_queries', true, {});
            savedQueries[name] = currentText;
            setSettings('saved_queries', savedQueries);

            this.parent.updateAllSavedQueriesDropdowns();
            this.$savedPrompts.val(name);
            toastDebounced(`Saved query: ${name}`);
            closePopover();
        };

        $popover.find('.enerccio_sidequery_popover_ok').on('click', submitSaveAs);
        $popover.find('.enerccio_sidequery_popover_cancel').on('click', closePopover);
        $input.on('keydown', (e) => {
            if (e.key === 'Enter') {
                submitSaveAs();
            } else if (e.key === 'Escape') {
                closePopover();
            }
        });
    }

    async trash() {
        await this.container.trash();
        this.loaded = false;
    }

    async save() {
        // Dynamically capture the scroll offset right before writing to storage
        if (this.$responseContainer && this.$responseContainer[0]) {
            this.scrollPosition = this.$responseContainer[0].scrollTop;
        }

        await this.parent.saveTab(this, {
            name: this.name,
            isManuallyRenamed: this.isManuallyRenamed,
            scrollPosition: this.scrollPosition,
            includePersona: this.includePersona,
            includeScenario: this.includeScenario,
            includeCharacters: this.includeCharacters,
            includeWorldinfo: this.includeWorldinfo,
            macroExpand: this.macroExpand,
            triggerType: this.triggerType,
            includeMessages: this.includeMessages,
            includeActorNames: this.includeActorNames,
            messagesCount: this.messagesCount,
            messagesCountTo: this.messagesCountTo,
            chat: this.container.toJSON()
        });
    }

    restoreScrollPosition() {
        if (this.$responseContainer && this.$responseContainer[0]) {
            requestAnimationFrame(() => {
                this.$responseContainer[0].scrollTop = this.scrollPosition;
            });
        }
    }

    isGenerating() {
        return this.abort != null && !this.abort.signal.aborted;
    }

    async generateReply() {
        const metadata = initializeRequestMetadata();
        this.abort = new AbortController();
        await this.updateButtonStates();
        const profile = metadata.cId;
        const queryData = await this.gatherQueryData();
        await this.updateTokenCount();
        let asyncGeneratorFunction = await context.ConnectionManagerRequestService.sendRequest(profile, queryData,
            profile.max_tokens, {stream: true, signal: this.abort.signal});
        const m = await this.container.insertAIMessage("");
        this.asyncGenerator = asyncGeneratorFunction();

        let text = "";
        let reasoningTime = null;
        let reasoningDone = false;
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
                const reasoning = returnFromGenerator.state?.reasoning;

                if (reasoning && reasoningTime === null) {
                    reasoningTime = performance.now();
                }

                m.setText(text);

                if (text) {
                    reasoningDone = true;
                }

                if (reasoning)
                    m.setReasoning(reasoning, performance.now() - reasoningTime, reasoningDone);
            }
        } catch (aborted) {
            if (aborted === 'userStopped') {
                log('Query generation aborted by user');
            } else {
                error("Query generation failed: " + aborted);
            }
            this.asyncGenerator = null;
            this.abort = null;
        } finally {
            m.forceUpdate();
            await this.save();
        }
        await this.updateButtonStates();
        await this.updateTokenCount();

        const aiNamesEnabled = getSettings("enable_ai_names", false, false);

        // Trigger title generation if enabled, it's the first response, and it was never manually overridden
        if (aiNamesEnabled && !this.isManuallyRenamed && this.container.messages.length === 2 && (!this.name || this.name.startsWith("Tab "))) {
            await this.generateTabTitle(profile);
        }
    }

    async generateTabTitle(profile) {
        try {
            log('Generating small title for the tab...');
            const userMsg = this.container.messages[0]?.contents || "";
            const aiMsg = this.container.messages[1]?.contents || "";

            const titlePrompt = [
                {
                    role: "system",
                    content: "You are a utility module. Generate a super short, extremely concise summary title (25 characters max) based on the user request and AI reply provided. Output ONLY the raw title text. Do not write explanations, do not use quotes, and do not include punctuation."
                },
                {
                    role: "user",
                    content: `User Request: ${userMsg}\nAI Reply: ${aiMsg}`
                }
            ];

            // Request a small chunk of tokens. Stream parameter matches the context capability safely.
            let titleGenFunction = await context.ConnectionManagerRequestService.sendRequest(profile, titlePrompt,
                2048, {stream: true});

            let resultText = "";

            if (typeof titleGenFunction === 'function') {
                const titleGenerator = titleGenFunction();
                // Consume the generator stream until completion loop
                while (true) {
                    let r = await titleGenerator.next();
                    if (r.done) break;
                    if (r.value && r.value.text) {
                        resultText = r.value.text;
                    }
                }
            } else if (titleGenFunction && titleGenFunction.text) {
                // Fallback wrapper if the endpoint natively ignored streaming entirely
                resultText = titleGenFunction.text;
            }

            let cleanedTitle = resultText.replace(/<think>[\s\S]*?<\/think>/gi, ""); // Strip thought blocks if present
            cleanedTitle = cleanedTitle.replace(/["'’\.\*#]/g, "").trim(); // Remove punctuation and markdown

            if (cleanedTitle) {
                if (cleanedTitle.length > 25) {
                    cleanedTitle = cleanedTitle.substring(0, 22) + "...";
                }

                this.name = cleanedTitle;
                await this.save();
                await this.parent.renameTab(this, cleanedTitle);
            }
        } catch (err) {
            console.error("Failed to generate tab title automatically", err);
        }
    }

    async gatherQueryData() {
        const queries = [];

        await this.container.insertMessages(queries);

        return queries;
    }

    async updateTokenCount() {
        const tokenCount = await this.container.countTokens();
        this.$tokenCount.text(`Token Count: ${tokenCount}`);
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
        this.$infoBtn = this.$contentPane.find(`#${MODULE_NAME}_info_btn`);
        this.$infoPopover = $('#enerccio_sidequery_global_info');
        this.currentInfoTab = 'pre'; // Track sub-view state: 'pre' or 'post'

        this.tabs = []
        this.activeTab = null;
        this.tabData = [];
        this.isRebuildingLayout = false;
        this.isSwitchingTab = false;
        this.$addTabBtn.on('click', () => this.addNewTab());

        this._wireInfoPopover();
    }

    _wireInfoPopover() {
        // Tab switching events inside the popover layout panel itself
        this.$infoPopover.find('.enerccio_sidequery_info_tab').on('click', (e) => {
            e.stopPropagation();
            this.currentInfoTab = $(e.currentTarget).data('info-tab');

            this.$infoPopover.find('.enerccio_sidequery_info_tab').removeClass('active');
            $(e.currentTarget).addClass('active');

            this._updateInfoPopoverContent();
        });

        // Toggle context logic for the primary information icon click
        this.$infoBtn.on('click', (e) => {
            e.stopPropagation();

            // Close standard options dropdown if open to keep things clean
            $('.enerccio_sidequery_options_menu_panel').hide();

            const isVisible = this.$infoPopover.is(':visible');
            if (!isVisible) {
                this.$infoPopover.css({ display: 'flex', visibility: 'hidden' });

                const btnOffset = this.$infoBtn.offset();
                const btnWidth = this.$infoBtn.outerWidth();
                const btnHeight = this.$infoBtn.outerHeight();
                const panelWidth = this.$infoPopover.outerWidth();
                const panelHeight = this.$infoPopover.outerHeight();

                const scrollTop = $(window).scrollTop();
                const scrollLeft = $(window).scrollLeft();

                // Position flush immediately to the right edge of the info button frame
                let leftPos = btnOffset.left + btnWidth + 6 - scrollLeft;
                let topPos = btnOffset.top - scrollTop;

                // Safety guardrails for edge-of-screen constraints
                if (leftPos + panelWidth > $(window).width() - 10) {
                    // Fallback: If right edge truncates workspace, flip open to the left side
                    leftPos = btnOffset.left - panelWidth - 6 - scrollLeft;
                }
                if (topPos + panelHeight > $(window).height() - 10) {
                    topPos = $(window).height() - panelHeight - 10;
                }
                if (topPos < 10) topPos = 10;

                this.$infoPopover.css({
                    left: leftPos + 'px',
                    top: topPos + 'px',
                    visibility: 'visible'
                });

                this._updateInfoPopoverContent();
            } else {
                this.$infoPopover.hide();
            }
        });

        // Suppress layout bubbling closure loops when selecting text inside textareas
        this.$infoPopover.on('click mousedown mouseup keydown keyup', (e) => {
            e.stopPropagation();
        });

        // Click wrapper boundary hide routing
        $(document).on('click.info-popover-hide', (e) => {
            if (!$(e.target).closest('#enerccio_sidequery_info_btn').length) {
                this.$infoPopover.hide();
            }
        });
    }

    // NEW: Updates text fields dynamically using configured setting definitions
    _updateInfoPopoverContent() {
        const prePrompt = getSettings('first_message', false, '');
        const postPrompt = getSettings('before_last_message', false, '');

        const targetString = this.currentInfoTab === 'pre' ? prePrompt : postPrompt;
        this.$infoPopover.find('#enerccio_sidequery_info_textarea').val(targetString);
    }

    updateAllSavedQueriesDropdowns() {
        for (let tab of this.tabs) {
            tab.updateSavedQueriesDropdown();
        }
    }

    ensureDrawerOpen() {
        const $drawerContent = this.$root.find('.inline-drawer-content');
        if ($drawerContent.css('display') === 'none') {
            this.$root.find('.inline-drawer-toggle').trigger('click');
        }
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
            $(`#${MODULE_NAME}_query`).show();
            this.hidden = false;
            this.ensureDrawerOpen();
            // Restore scroll for the active tab view after opening the main drawer
            const currentTab = this.tab();
            if (currentTab) currentTab.restoreScrollPosition();
        } else {
            // Save current position state before putting elements away
            const currentTab = this.tab();
            if (currentTab) await currentTab.save();

            $(`#${MODULE_NAME}_query`).hide();
            this.hidden = true;
        }
    }

    async load() {
        this.currentChatId = SillyTavern.getContext().chatId;

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

    async saveTab(tab, tabData) {
        this.tabData[this.tabs.indexOf(tab)] = tabData;
        await this.save();
    }

    async renameTab(tab, newName) {
        const idx = this.tabs.indexOf(tab);
        if (idx !== -1 && this.tabData[idx]) {
            this.tabData[idx].name = newName;
            await this.updateTabs();
            await this.save();
        }
    }

    async save() {
        if (this.currentChatId && this.currentChatId !== SillyTavern.getContext().chatId) {
            log("Cross-chat write blocked inside SideQueryTabs.save() to prevent tab data erasure.");
            return;
        }

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
        this.isRebuildingLayout = true; // Lock scrolling loops while header DOM changes
        this.$tabsContainer.empty();

        const showClose = this.tabData.length > 1;

        for (let i = 0; i < this.tabData.length; i++) {
            const tabName = this.tabData[i]?.name || `Tab ${i + 1}`;
            // Added draggable="true" attribute to enable native HTML5 drag capability
            const $tabBtn = $(`
                        <div class="${MODULE_NAME}_tabbtn ${i === this.activeTab ? 'active' : ''}" data-index="${i}" draggable="true">
                            <span class="tab-title-text">${tabName}</span>
                            <div class="tab-actions" style="display: flex; gap: 6px; margin-left: 8px; align-items: center;">
                                <i class="fas fa-pencil edit-tab" title="Rename Tab" style="font-size: 0.8em; opacity: 0.5; cursor: pointer; transition: opacity 0.2s;"></i>
                                <i class="fas fa-times close-tab" title="Close Tab" style="${showClose ? '' : 'display: none;'}"></i>
                            </div>
                        </div>
                    `);

            // --- Core Drag and Drop Event Routing Mechanics ---
            $tabBtn.on('dragstart', (e) => {
                if (this.isGenerating()) {
                    e.preventDefault();
                    return;
                }
                // Store the index of the element being picked up
                e.originalEvent.dataTransfer.setData('text/plain', i.toString());
                $tabBtn.addClass('dragging');
                e.stopPropagation();
            });

            $tabBtn.on('dragover', (e) => {
                // dragover must be explicitly prevented for a valid drop area zone target
                e.preventDefault();
                $tabBtn.addClass('drag-over');
                e.stopPropagation();
            });

            $tabBtn.on('dragleave', (e) => {
                $tabBtn.removeClass('drag-over');
                e.stopPropagation();
            });

            $tabBtn.on('dragend', (e) => {
                this.$tabsContainer.find(`.${MODULE_NAME}_tabbtn`).removeClass('dragging drag-over');
                e.stopPropagation();
            });

            $tabBtn.on('drop', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                $tabBtn.removeClass('drag-over');

                const fromIndex = parseInt(e.originalEvent.dataTransfer.getData('text/plain'), 10);
                const toIndex = i;

                if (isNaN(fromIndex) || fromIndex === toIndex) return;

                // Splice and re-insert items inside tabData arrays to reorder natively
                const [movedData] = this.tabData.splice(fromIndex, 1);
                this.tabData.splice(toIndex, 0, movedData);

                // Splice and sync running active instances array matching data indices
                const [movedTab] = this.tabs.splice(fromIndex, 1);
                this.tabs.splice(toIndex, 0, movedTab);

                // Re-calculate focus tracker pointer position so selection follows your tab
                if (this.activeTab === fromIndex) {
                    this.activeTab = toIndex;
                } else if (this.activeTab > fromIndex && this.activeTab <= toIndex) {
                    this.activeTab--;
                } else if (this.activeTab < fromIndex && this.activeTab >= toIndex) {
                    this.activeTab++;
                }

                await this.updateTabs();
                await this.save();

                // Keep visually synchronized with the newly repositioned tab element view pane
                if (this.tabs[this.activeTab]) {
                    this.$contentPane.find(`#${MODULE_NAME}_tabs_tabcontent`).children().hide();
                    this.tabs[this.activeTab].$root.show();
                    this._scrollToActiveTab();
                }
            });
            // ---------------------------------------------------

            // Core renaming logic bundled into a clean helper function
            const startInlineRename = (e) => {
                if (this.isGenerating()) return;
                e.stopPropagation();

                const $span = $tabBtn.find('.tab-title-text');
                const currentName = $span.text();
                const $input = $(`<input type="text" class="text_pole" value="${currentName}" style="width: 80px; height: 20px; font-size: 0.9em; padding: 2px; margin: 0; display: inline-block;"/>`);

                $span.replaceWith($input);
                $input.focus().select();

                $input.on('click mousedown mouseup keydown keyup', (inputEvent) => {
                    inputEvent.stopPropagation();
                });

                const finishRename = async () => {
                    const newName = $input.val().trim() || `Tab ${i + 1}`;
                    this.tabData[i].name = newName;
                    this.tabData[i].isManuallyRenamed = true;

                    if (this.tabs[i]) {
                        this.tabs[i].name = newName;
                        this.tabs[i].isManuallyRenamed = true;
                        await this.tabs[i].save();
                    }

                    await this.updateTabs();
                    await this.save();
                };

                $input.on('blur', finishRename);
                $input.on('keydown', (ev) => {
                    if (ev.key === 'Enter') {
                        $input.off('blur');
                        finishRename();
                    } else if (ev.key === 'Escape') {
                        $input.off('blur');
                        this.updateTabs();
                    }
                });
            };

            // Single click event router
            $tabBtn.on('click', (e) => {
                if (this.isGenerating()) return;

                if ($(e.target).is('input') || $(e.target).closest('input').length > 0) {
                    return;
                }

                if ($(e.target).hasClass('close-tab')) {
                    this.closeTab(i);
                } else if ($(e.target).hasClass('edit-tab')) {
                    startInlineRename(e);
                } else {
                    this.onTabClicked(i);
                }
            });

            // Keep double click active as an alternative convenience shortcut
            $tabBtn.on('dblclick', (e) => {
                if ($(e.target).hasClass('close-tab') || $(e.target).hasClass('edit-tab')) return;
                startInlineRename(e);
            });

            this.$tabsContainer.append($tabBtn);
        }

        if (this.tabs.length !== this.tabData.length) {
            await this.syncTabs();
        }

        this.isRebuildingLayout = false;
    }

    async syncTabs() {
        this.tabs.forEach(t => t.$root?.remove());
        this.tabs = [];

        for (let i = 0; i < this.tabData.length; i++) {
            const $tabRoot = $(QUERY_TEMPLATE).appendTo(this.$tabdata);
            const tab = new SideQuery(this, $tabRoot);
            await tab.wire();
            await tab.load(this.tabData[i]);
            this.tabs.push(tab);
        }

        this.$contentPane.find(`#${MODULE_NAME}_tabs_tabcontent`).children().hide();
        if (this.activeTab !== null && this.tabs[this.activeTab]) {
            await this.showActiveTab();
        }
    }

    async addNewTab() {
        if (this.isGenerating())
            return;

        const currentTab = (this.activeTab !== null && this.tabData[this.activeTab])
            ? this.tabData[this.activeTab]
            : null;

        this.tabData.push({
            name: `Tab ${this.tabData.length + 1}`,
            isManuallyRenamed: false,
            scrollPosition: 0,
            includePersona: currentTab ? currentTab.includePersona : false,
            includeScenario: currentTab ? currentTab.includeScenario : false,
            includeCharacters: currentTab ? currentTab.includeCharacters : false,
            includeWorldinfo: currentTab ? currentTab.includeWorldinfo : false,
            macroExpand: currentTab ? (currentTab.macroExpand ?? true) : true,
            triggerType: currentTab ? (currentTab.triggerType ?? 'normal') : 'normal',
            includeMessages: currentTab ? (currentTab.includeMessages ?? false) : false,
            messagesCount: currentTab ? (currentTab.messagesCount ?? 0) : 0,
            messagesCountTo: currentTab ? (currentTab.messagesCountTo ?? 5) : 5,
            chat: { messages: [] }
        });
        this.activeTab = this.tabData.length - 1;
        await this.updateTabs();
        requestAnimationFrame(() => {
            this._scrollToActiveTab();
        });
        await this.save();
    }

    async closeTab(index) {
        if (this.tabData.length <= 1) {
            return;
        }

        const wasActive = this.activeTab === index;

        this.tabData.splice(index, 1);
        const [closedTab] = this.tabs.splice(index, 1);
        if (closedTab) {
            await closedTab.trash();
        }

        if (wasActive) {
            let newActive = index;
            if (newActive >= this.tabData.length) {
                newActive = this.tabData.length - 1;
            }
            this.activeTab = null;
            await this.onTabClicked(newActive);
            await this.save();
        } else {
            if (this.activeTab > index) {
                this.activeTab--;
            }
            await this.updateTabs();
            await this.save();
        }
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

    async onTabClicked(index) {
        if (index === null || this.activeTab === index || this.isSwitchingTab) {
            return;
        }

        if ($globalOptionsPopover) $globalOptionsPopover.hide();
        this.isSwitchingTab = true;
        try {
            // If there's an active tab, save its state before switching away.
            if (this.activeTab !== null && this.tabs[this.activeTab]) {
                await this.tabs[this.activeTab].save();
            }

            this.activeTab = index;
            await this.updateTabs();
            await this.showActiveTab();
            this._scrollToActiveTab();
        } finally {
            this.isSwitchingTab = false;
        }
    }

    async showActiveTab() {
        const targetActiveTab = this.activeTab; // Snapshot the target index for this specific loop execution trace
        this.$contentPane.find(`#${MODULE_NAME}_tabs_tabcontent`).children().hide();

        for (let i = 0; i < this.tabs.length; i++) {
            // If the active tab index advanced under our feet due to another trigger, abort this stale loop immediately
            if (this.activeTab !== targetActiveTab) return;

            const t = this.tabs[i];
            if (!t) continue;

            if (i === targetActiveTab) {
                await t.fill();
                // Verify structural identity parameters haven't changed during the async yield point
                if (this.activeTab === targetActiveTab) {
                    t.$root.show();
                }
            } else {
                await t.trash();
                // Safe layout allocation preparation step
                if (this.tabs[i] && this.tabData[i]) {
                    await t.load(this.tabData[i]);
                }
            }
        }
    }

}

let sideQueryTabs;
let QUERY_TEMPLATE;
let MESSAGE_TEMPLATE;
let $globalOptionsPopover;
let $globalInfoPopover;

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

    const globalPanelsHtml = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'global_panels',
        { title: EXTENSION_NAME, version: VERSION }
    );
    $('body').append(globalPanelsHtml);

    // Assign instances to our centralized module trackers
    $globalOptionsPopover = $('#enerccio_sidequery_global_options');
    $globalInfoPopover = $('#enerccio_sidequery_global_info');

    $('#movingDivs').append(tabs);
    const $sideQuery = $(`#${MODULE_NAME}_query`);
    sideQueryTabs = new SideQueryTabs($sideQuery);

    const $button = $(`<button class="${MODULE_NAME}_openButton menu_button interactable"><i class="fas fa-search"></i></button>'`)
    $('body').append($button);
    $button.attr('disabled', true);

    context.eventSource.on(event_types.CHAT_CHANGED, async () => {
        $button.attr('disabled', !context.getCurrentChatId());

        if (sideQueryTabs) {
            // 1. Proactively abort any active background text generation streams
            for (let tab of sideQueryTabs.tabs) {
                if (tab.isGenerating()) {
                    tab.abort.abort("chatChanged");
                }
            }
            // 2. Clear volatile data allocations from memory to prevent stale reference leaks
            await sideQueryTabs.clear();
        }

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
