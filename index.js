import { log } from './utils.js';
import {EXTENSION_NAME, EXTENSION_PATH, MODULE_NAME, VERSION} from './conf.js';
import {renderExtensionTemplateAsync} from "/scripts/extensions.js";
import {event_types} from "/scripts/events.js";
import {set_character_enabled_button_states} from "/scripts/extensions/third-party/SillyTavern-Reviewer/settings.js";

// eslint-disable-next-line no-undef
const $ = jQuery;
const context = SillyTavern.getContext();

class SidePrompt {

    constructor(root) {
        this.$contentPane = root;
        this.$root = $("#enerccio_sidequery_prompt_content");
        this.hidden = true;
    }

    async load() {

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


$(async function () {
    log('Loading extension...');

    const sidePromptTemplate = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'prompt',
        { title: EXTENSION_NAME, version: VERSION }
    );
    $('#movingDivs').append(sidePromptTemplate);
    const $sidePrompt = $('#enerccio_sidequery_prompt');
    sidePrompt = new SidePrompt($sidePrompt);

    const $button = $(`<button class="${MODULE_NAME}_openButton"><i class="fas fa-search"></i></button>'`)
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
