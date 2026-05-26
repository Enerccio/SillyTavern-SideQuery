# SillyTavern-SideQuery
This extension adds a side query panel to SillyTavern, allowing you to generate AI responses based on the current chat's worldinfo, characters, and persona without interfering with the main chat flow.

Every side query session is saved with the current chat, ensuring your research and notes persist.

## Features
- **Multi-Tab Support**: Create multiple query tabs to track different threads of thought or research simultaneously.
- **Customizable Context**: Choose exactly what information is sent to the AI for each query:
    - Persona
    - Character definitions
    - World Info (Lorebook)
    - Scenario
    - Message range from the current chat
- **Independent Connection**: Use a different connection profile for side queries than the one used for the main chat.
- **Thought Process Visibility**: Supports displaying reasoning/thinking blocks if the underlying model provides them.
- **Chat Management**: Undo last messages or regenerate the last AI response.
- **Include and exclude worldinfo entries**:
    - **Include**: Select which worldinfo entries to include in the context - use SIDEQUERY_TRIGGER as keyword.
    - **Exclude**: To exclude specific entries, mark them as all triggers (or at least one of the triggers).

## How to install
1. Paste the URL of this repository into the **Install extension** dialog in SillyTavern.
2. Go to the **Extensions** tab to configure the connection profile for side queries.
3. (Optional) Customize the initial system query and instructions in the settings.

## Configuration
In the extension settings, you can:
- **Connection Profile**: Select a specific profile or use the "Same as Current" setting.
- **Initial Query**: Define the system prompt that initializes every new side query.
- **Instructions before user input**: Add specific formatting or behavioral instructions that are injected immediately before your query.

## Example

![Example](README/img.png)
