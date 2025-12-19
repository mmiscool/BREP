export function createInspectorToggleButton(viewer) {
    const onClick = () => {
        try {
            viewer && viewer.toggleInspectorPanel && viewer.toggleInspectorPanel();
        } catch {}
    };
    return {
        label: '🕵️',
        title: 'Toggle Inspector panel',
        onClick
    };
}