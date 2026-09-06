// features/text-edit/TextBlockEditLayer.tsx
//
// Floating TipTap editor for `text-block` overlays. Shown above the
// canvas when the user clicks a text-block while the `edit-text` tool is
// active. On commit (blur or Ctrl+Enter) it updates the overlay's text and
// segments in place -- no engine round-trip, no pdfBytes rewrite.
//
// 重构后(Phase C):contentEditable + execCommand 替换为 TipTap 富文本编辑器。
// RichTextSegment[] 边界不变,store/export 管线零改动。
//
// Selection 行为:
//   * 单击 block:仅选中 (selectedOverlayId = block.id)
//   * 双击 block:进入画布内嵌 TipTap 直接改字
//   * 选中状态下再次单击同一 block:直接进入内嵌编辑
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDocumentStore } from '../../store/documentStore';
import { useEditorStore } from '../../store/editorStore';
import { useCommitTextBlock } from './useCommitTextBlock';
import { RichTextEditor } from './RichTextEditor';
import type { TextBlockItem, RichTextSegment, PageMeta } from '../../core/types';

// ---------- Component --------------------------------------------------------

export interface TextBlockEditLayerProps {
  page: PageMeta;
}

export function TextBlockEditLayer({ page }: TextBlockEditLayerProps) {
  const tool = useEditorStore((s) => s.tool);
  const zoom = useEditorStore((s) => s.zoom);
  const selectedOverlayId = useEditorStore((s) => s.selectedOverlayId);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const overlays = useDocumentStore((s) => s.overlays);
  const removeOverlay = useDocumentStore((s) => s.removeOverlay);
  // 采样到的块局部页面背景色:编辑态用它替代白色,彩色页面底色不跳变。
  const pageBgColors = useDocumentStore((s) => s.pageBgColors);

  const editingIdRef = useRef<string | null>(null);
  // commitFnRef: RichTextEditor 注册的提交函数,父组件可手动调用
  // (切换 block / 切换工具时,blur 可能不触发)。
  const commitFnRef = useRef<(() => void) | null>(null);
  // Stable callback so RichTextEditor's useEffect doesn't re-run each render.
  const registerCommit = useCallback((fn: (() => void) | null) => {
    commitFnRef.current = fn;
  }, []);

  // 共享的"写回 overlay"逻辑(同样被 Inspector 用)。
  const { commit: commitToOverlay } = useCommitTextBlock();

  // Force-update tick: editingId is stored in a ref (not state) so we need
  // a manual re-render trigger when it changes.
  const [, setTick] = useState(0);
  const forceUpdate = () => setTick((t) => t + 1);

  useEffect(() => {
    if (tool !== 'edit-text') {
      // 切换工具时,如果正在编辑,先提交编辑内容到 store。
      if (editingIdRef.current && commitFnRef.current) {
        commitFnRef.current();
      }
      editingIdRef.current = null;
      commitFnRef.current = null;
    }
  }, [tool]);

  if (tool !== 'edit-text') return null;
  const blocks = overlays.filter(
    (o): o is TextBlockItem => o.type === 'text-block' && o.pageId === page.id
  );

  function selectOnly(block: TextBlockItem) {
    setSelectedOverlayId(block.id);
  }

  // Commit the in-progress edit (if any) without relying on onBlur, which
  // may not fire because pointerdown on another block calls preventDefault
  // and keeps the editor focused.
  function commitCurrentEdit() {
    if (commitFnRef.current) {
      commitFnRef.current();
    }
  }

  function startEdit(block: TextBlockItem) {
    editingIdRef.current = block.id;
    setSelectedOverlayId(block.id);
    forceUpdate();
  }

  function commitEdit(
    block: TextBlockItem | undefined,
    newText: string,
    segments?: RichTextSegment[]
  ) {
    // 失焦提交后不再保留选中态:用户点空白处提交时,前一个块应取消选中。
    // 若本次失焦由点击另一块触发,该块的 onPointerDown 会立即重新选中它。
    setSelectedOverlayId(null);
    if (!block) {
      editingIdRef.current = null;
      commitFnRef.current = null;
      forceUpdate();
      return;
    }
    commitToOverlay({
      block,
      pageIndex: page.index,
      newText,
      segments,
    });
    editingIdRef.current = null;
    commitFnRef.current = null;
    forceUpdate();
  }

  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ width: page.width * zoom, height: page.height * zoom }}
    >
      {blocks.map((b) => {
        const isSelected = selectedOverlayId === b.id;
        const isEditing = editingIdRef.current === b.id;
        return (
          <div
            key={b.id}
            className={
              'absolute rounded-sm ' +
              (isSelected || isEditing
                ? 'border-2 border-blue-600 border-dashed'
                : 'border border-blue-400 border-dashed opacity-60 hover:opacity-100')
            }
            style={{
              left: b.bbox.x * zoom,
              top: b.bbox.y * zoom,
              width: b.bbox.w * zoom,
              height: b.bbox.h * zoom,
              pointerEvents: 'auto',
              cursor: 'text',
              // 编辑态底色 = 渲染时采样到的该块局部页面背景(导出 whiteout
              // 也用同一颜色),保证进入编辑时视觉不跳变。
              background: isEditing ? (pageBgColors[b.id] ?? '#ffffff') : undefined,
            }}
            onPointerDown={(e) => {
              if (isEditing) return;
              e.preventDefault();
              e.stopPropagation();
              // Commit any in-progress edit on another block before switching.
              if (editingIdRef.current && editingIdRef.current !== b.id) {
                commitCurrentEdit();
              }
              if (isSelected) {
                startEdit(b);
              } else {
                selectOnly(b);
              }
            }}
            onDoubleClick={(e) => {
              if (isEditing) return;
              e.preventDefault();
              e.stopPropagation();
              if (editingIdRef.current && editingIdRef.current !== b.id) {
                commitCurrentEdit();
              }
              startEdit(b);
            }}
          >
            {isEditing ? (
              <RichTextEditor
                key={b.id}
                block={b}
                zoom={zoom}
                onCommit={(text, segments) => commitEdit(b, text, segments)}
                onCancel={() => {
                  editingIdRef.current = null;
                  commitFnRef.current = null;
                  setSelectedOverlayId(null);
                  forceUpdate();
                }}
                registerCommit={registerCommit}
              />
            ) : null}
            {!isEditing && (
              <button
                type="button"
                title="删除此文本块"
                onClick={(e) => {
                  e.stopPropagation();
                  removeOverlay(b.id);
                  if (selectedOverlayId === b.id) setSelectedOverlayId(null);
                }}
                className="absolute -right-3 -top-3 hidden h-5 w-5 items-center justify-center rounded-full border border-red-400 bg-white text-[10px] text-red-600 group-hover:flex"
              >
                x
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
