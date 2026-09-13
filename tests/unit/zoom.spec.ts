// zoom.spec.ts — regression net for the zoom stepping bug.
//
// The old implementation stepped by "nearest level to current ± 0.25".
// Because ZOOM_LEVELS is unevenly spaced (… 1, 1.5 …), the target 1.25 was
// equidistant from 1.0 and 1.5, and the strict `<` comparison kept the
// earlier (lower) value — so zoom-in was a **no-op from 100% upward**, which
// is exactly the default zoom. These tests fail on the old implementation.
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore, ZOOM_LEVELS } from '../../src/store/editorStore';

describe('editorStore zoom stepping', () => {
  beforeEach(() => {
    useEditorStore.setState({ zoom: 1 });
  });

  it('zooms in from the default 100%', () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      useEditorStore.getState().zoomIn();
      seen.push(useEditorStore.getState().zoom);
    }
    // Previously: [1, 1, 1, 1] — completely stuck.
    expect(seen).toEqual([1.5, 2, 4, 4]);
  });

  it('zooms out from 100% down to the smallest level, then clamps', () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      useEditorStore.getState().zoomOut();
      seen.push(useEditorStore.getState().zoom);
    }
    expect(seen).toEqual([0.75, 0.5, 0.25, 0.25]);
  });

  it('reaches every level walking up from the minimum', () => {
    useEditorStore.setState({ zoom: ZOOM_LEVELS[0] });
    const reached: number[] = [ZOOM_LEVELS[0]];
    for (let i = 0; i < ZOOM_LEVELS.length + 3; i += 1) {
      useEditorStore.getState().zoomIn();
      const z = useEditorStore.getState().zoom;
      if (z !== reached[reached.length - 1]) reached.push(z);
    }
    expect(reached).toEqual([...ZOOM_LEVELS]);
  });

  it('reaches every level walking down from the maximum', () => {
    const top = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
    useEditorStore.setState({ zoom: top });
    const reached: number[] = [top];
    for (let i = 0; i < ZOOM_LEVELS.length + 3; i += 1) {
      useEditorStore.getState().zoomOut();
      const z = useEditorStore.getState().zoom;
      if (z !== reached[reached.length - 1]) reached.push(z);
    }
    expect(reached).toEqual([...ZOOM_LEVELS].reverse());
  });

  it('handles off-level values without skipping a level', () => {
    // A future "fit width" mode may compute arbitrary zoom values.
    useEditorStore.setState({ zoom: 0.9 });
    useEditorStore.getState().zoomIn();
    expect(useEditorStore.getState().zoom).toBe(1);

    useEditorStore.setState({ zoom: 1.2 });
    useEditorStore.getState().zoomIn();
    expect(useEditorStore.getState().zoom).toBe(1.5);

    useEditorStore.setState({ zoom: 3 });
    useEditorStore.getState().zoomOut();
    expect(useEditorStore.getState().zoom).toBe(2);
  });

  it('round-trips up and back down', () => {
    for (let i = 0; i < ZOOM_LEVELS.length; i += 1) useEditorStore.getState().zoomIn();
    expect(useEditorStore.getState().zoom).toBe(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
    for (let i = 0; i < ZOOM_LEVELS.length; i += 1) useEditorStore.getState().zoomOut();
    expect(useEditorStore.getState().zoom).toBe(ZOOM_LEVELS[0]);
  });
});
