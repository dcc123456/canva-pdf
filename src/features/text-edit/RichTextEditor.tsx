/* eslint-disable react-refresh/only-export-components */
// features/text-edit/RichTextEditor.tsx
//
// TipTap 富文本编辑器封装。支持样式:
//   bold, italic, underline, strike, color, fontSize, fontFamily
// 空格和换行保留(preserve-spans + pre-wrap)。
import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, FontSize } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { Underline } from '@tiptap/extension-underline';
import { FontFamily } from '@tiptap/extension-font-family';
import { Text } from '@tiptap/extension-text';
import type { Editor, JSONContent } from '@tiptap/core';
import type { FontClass, RichTextSegment, TextBlockItem } from '../../core/types';
import { FONT_CLASS_TO_CSS, pdfFirstFontFamily } from '../../core/engine/fontClassify';

// ---------- Custom Text extension: preserve all whitespace -------------------
// ProseMirror's default text node trims/collapses whitespace per HTML rules.
// This extension forces preserveWhitespace:'full' so that spaces between
// font-runs (e.g. "Hello " + "world") are never lost during editing.
const PreserveText = Text.extend({
  parseHTML() {
    return [{ tag: '#text', preserveWhitespace: 'full' as const }];
  },
});

// ---------- Custom FontSize extension -----------------------------------------
// TipTap 3.x ships a built-in FontSize sub-extension via @tiptap/extension-text-style
// (imported above). It exposes `setFontSize(string)` / `unsetFontSize()` commands
// and stores the value as a CSS string (e.g. '16px'). The conversion between
// the segment's numeric fontSize and the CSS string happens in
// segmentsToTipTapContent / editorToSegments below.

// ---------- Style key for merge comparison ------------------------------------

function styleKey(seg: RichTextSegment): string {
  return [
    !!seg.bold,
    !!seg.italic,
    !!seg.underline,
    !!seg.strike,
    seg.color || '',
    seg.fontSize ?? 0,
    seg.fontFamily || '',
    seg.fontClass ?? '',
  ].join('|');
}

// ---------- RichTextSegment <-> TipTap JSON ----------------------------------

export interface BlockDefaults {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  fontClass?: FontClass;
  /** 检测后按 segment bbox 反推的文字色(检测颜色缺失时的补充元数据)。 */
  segTextColors?: string[];
}

export function segmentsToTipTapContent(
  segments: RichTextSegment[] | undefined,
  text: string,
  blockDefaults?: BlockDefaults,
  zoom = 1
): JSONContent {
  const hasSegments = segments && segments.length > 0;

  const buildMarks = (
    seg: RichTextSegment,
    segIndex: number
  ): { type: string; attrs?: Record<string, unknown> }[] => {
    const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
    const isBold = hasSegments ? !!seg.bold : (seg.bold ?? blockDefaults?.bold);
    const isItalic = hasSegments ? !!seg.italic : (seg.italic ?? blockDefaults?.italic);
    const isUnderline = hasSegments ? !!seg.underline : (seg.underline ?? false);
    const isStrike = hasSegments ? !!seg.strike : (seg.strike ?? false);
    const color =
      seg.color ??
      blockDefaults?.segTextColors?.[segIndex] ??
      blockDefaults?.color;
    const fontSize = seg.fontSize ?? blockDefaults?.fontSize;
    const fontClass = seg.fontClass ?? blockDefaults?.fontClass;
    // Resolve fontClass -> CSS font-family. Fall back to seg.fontFamily
    // (legacy PDF font name, browser will substitute) only if fontClass
    // is absent -- this should not happen post-ADR-0001, but kept for
    // backward compatibility with old .minipdf.json projects.
    const cssFontFamily = fontClass
      ? FONT_CLASS_TO_CSS[fontClass]
      : (seg.fontFamily ?? blockDefaults?.fontFamily);
    // WYSIWYG: PDF 原字体名优先(本机装了该字体即还原原字形),
    // FontClass 映射字体兜底(原字体未安装时视觉仍接近)。
    const fontFamilyAttr =
      fontClass && cssFontFamily
        ? pdfFirstFontFamily(
            seg.fontFamily ?? blockDefaults?.fontFamily,
            cssFontFamily
          )
        : cssFontFamily;

    if (isBold) marks.push({ type: 'bold' });
    if (isItalic) marks.push({ type: 'italic' });
    if (isUnderline) marks.push({ type: 'underline' });
    if (isStrike) marks.push({ type: 'strike' });

    const tsAttrs: Record<string, unknown> = {};
    if (color) tsAttrs.color = color;
    // Built-in FontSize stores a CSS string (e.g. '16px'); convert from the
    // numeric segment value. Segment 字号是 PDF pt 单位,乘 zoom 与块 bbox
    // 的屏幕尺寸保持一致(编辑器容器字号同样是 pt*zoom)。
    if (fontSize) tsAttrs.fontSize = `${fontSize * zoom}px`;
    if (fontFamilyAttr) tsAttrs.fontFamily = fontFamilyAttr;
    if (Object.keys(tsAttrs).length > 0) {
      marks.push({ type: 'textStyle', attrs: tsAttrs });
    }
    return marks;
  };

  const pushText = (
    content: JSONContent[],
    textPart: string,
    seg: RichTextSegment,
    segIndex: number
  ) => {
    if (!textPart) return;
    content.push({
      type: 'text',
      text: textPart,
      marks: buildMarks(seg, segIndex),
    });
  };

  const content: JSONContent[] = [];
  const segs = hasSegments
    ? segments!
    : [{
        text,
        bold: blockDefaults?.bold,
        italic: blockDefaults?.italic,
        color: blockDefaults?.color,
        fontSize: blockDefaults?.fontSize,
        fontFamily: blockDefaults?.fontFamily,
        fontClass: blockDefaults?.fontClass,
      }];

  segs.forEach((seg, segIndex) => {
    const parts = seg.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) content.push({ type: 'hardBreak' });
      pushText(content, parts[i], seg, segIndex);
    }
  });

  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

export function editorToSegments(
  editor: Editor,
  zoom = 1
): { text: string; segments: RichTextSegment[] } {
  const json = editor.getJSON();
  const raw: RichTextSegment[] = [];

  function processNode(
    node: JSONContent,
    inherited: {
      bold: boolean;
      italic: boolean;
      underline: boolean;
      strike: boolean;
      color?: string;
      fontSize?: number;
      fontFamily?: string;
      fontClass?: FontClass;
    }
  ): void {
    if (node.type === 'text') {
      const marks = node.marks || [];
      const seg: RichTextSegment = { text: node.text || '' };
      if (inherited.bold || marks.some((m) => m.type === 'bold')) seg.bold = true;
      if (inherited.italic || marks.some((m) => m.type === 'italic')) seg.italic = true;
      if (inherited.underline || marks.some((m) => m.type === 'underline')) seg.underline = true;
      if (inherited.strike || marks.some((m) => m.type === 'strike')) seg.strike = true;

      const ts = marks.find((m) => m.type === 'textStyle');
      const attrs = ts?.attrs as Record<string, unknown> | undefined;
      const color = (attrs?.color as string) || inherited.color;
      // Built-in FontSize stores the value as a CSS string (e.g. '16px').
      // Parse it back to a number for RichTextSegment, undoing the zoom
      // scaling applied in segmentsToTipTapContent (stored value = pt*zoom).
      const fontSizeRaw = (attrs?.fontSize as string | number | undefined) ?? inherited.fontSize;
      const fontSizeScaled =
        typeof fontSizeRaw === 'string'
          ? parseFloat(fontSizeRaw)
          : fontSizeRaw;
      const fontSize = zoom !== 1 && fontSizeScaled
        ? fontSizeScaled / zoom
        : fontSizeScaled;
      const fontFamily = (attrs?.fontFamily as string | undefined) || inherited.fontFamily;
      const fontClass = (attrs?.fontClass as FontClass | undefined) || inherited.fontClass;
      if (color) seg.color = color;
      if (fontSize && Number.isFinite(fontSize)) seg.fontSize = fontSize;
      if (fontFamily) seg.fontFamily = fontFamily;
      if (fontClass) seg.fontClass = fontClass;
      raw.push(seg);
    } else if (node.type === 'hardBreak') {
      const seg: RichTextSegment = { text: '\n' };
      if (inherited.bold) seg.bold = true;
      if (inherited.italic) seg.italic = true;
      if (inherited.underline) seg.underline = true;
      if (inherited.strike) seg.strike = true;
      if (inherited.color) seg.color = inherited.color;
      if (inherited.fontSize) seg.fontSize = inherited.fontSize;
      if (inherited.fontFamily) seg.fontFamily = inherited.fontFamily;
      if (inherited.fontClass) seg.fontClass = inherited.fontClass;
      raw.push(seg);
    }
  }

  function processParagraph(para: JSONContent): void {
    if (!para.content || para.content.length === 0) {
      raw.push({ text: '' });
      return;
    }
    for (const child of para.content) {
      processNode(child, {
        bold: false,
        italic: false,
        underline: false,
        strike: false,
      });
    }
  }

  if (json.content) {
    for (let i = 0; i < json.content.length; i++) {
      if (i > 0) raw.push({ text: '\n' });
      processParagraph(json.content[i]);
    }
  }

  // Merge adjacent segments with identical style.
  const merged: RichTextSegment[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && styleKey(last) === styleKey(seg)) {
      last.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  const fullText = merged.map((s) => s.text).join('');
  return { text: fullText, segments: merged };
}

// ---------- Component ---------------------------------------------------------

export interface RichTextEditorProps {
  block: TextBlockItem;
  zoom: number;
  onCommit: (text: string, segments?: RichTextSegment[]) => void;
  onCancel: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
}

export function RichTextEditor({
  block,
  zoom,
  onCommit,
  onCancel,
  registerCommit,
}: RichTextEditorProps) {
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  // zoom 通过 ref 读取:useEditor 的回调闭包只创建一次,直接捕获 zoom
  // 会在缩放后拿到旧值。
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const latestContentRef = useRef<{ text: string; segments: RichTextSegment[] } | null>(null);
  const committedRef = useRef(false);
  const [toolbarRect, setToolbarRect] = useState<DOMRect | null>(null);
  // Ref to the floating toolbar DOM node. Used to detect whether a blur of the
  // editor was caused by clicking inside the toolbar (e.g., the font-size
  // input or font-family select) -- if so, we keep the editor mounted and the
  // toolbar visible so the user can finish interacting with the control.
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  const doCommit = useCallback((text: string, segments: RichTextSegment[]) => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommitRef.current(text, segments);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        codeBlock: false,
        listItem: false,
        horizontalRule: false,
        text: false,
      }),
      PreserveText,
      TextStyle,
      Color,
      Underline,
      FontFamily,
      FontSize,
    ],
    content: segmentsToTipTapContent(block.segments, block.text, {
      bold: block.bold,
      italic: block.italic,
      color: block.color,
      fontSize: block.fontSize,
      fontFamily: block.font,
      fontClass: block.fontClass,
      segTextColors: block.segTextColors,
    }, zoom),
    autofocus: true,
    onUpdate: ({ editor: ed }) => {
      latestContentRef.current = editorToSegments(ed, zoomRef.current);
    },
    editorProps: {
      attributes: {
        style: [
          'outline: none',
          `font-size: ${Math.max(8, block.fontSize * zoom)}px`,
          `line-height: ${block.lineHeight || 1.2}`,
          `font-family: ${block.fontClass ? pdfFirstFontFamily(block.font, FONT_CLASS_TO_CSS[block.fontClass]) : block.font}`,
          `color: ${block.color || '#000000'}`,
          'padding: 0',
          'white-space: pre-wrap',
          'word-break: break-word',
        ].join(';'),
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          const ed = editor;
          if (ed && !ed.isDestroyed) {
            const { text, segments } = editorToSegments(ed, zoomRef.current);
            doCommit(text, segments);
          }
          return true;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancelRef.current();
          return true;
        }
        return false;
      },
    },
    onBlur: ({ editor: ed }) => {
      const { text, segments } = editorToSegments(ed, zoomRef.current);
      // Defer the commit decision: if focus moved into the floating toolbar
      // (e.g., the font-size input or font-family select), keep the editor
      // mounted and the toolbar visible. Only commit when focus truly leaves
      // both the editor and the toolbar.
      window.setTimeout(() => {
        const active = document.activeElement;
        const toolbar = toolbarRef.current;
        if (toolbar && active && toolbar.contains(active)) {
          // Focus moved into the toolbar -- keep editing.
          return;
        }
        doCommit(text, segments);
        setToolbarRect(null);
      }, 0);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      const sel = ed.state.selection;
      if (sel.empty) {
        setToolbarRect(null);
        return;
      }
      const view = ed.view;
      const start = view.coordsAtPos(sel.from);
      const end = view.coordsAtPos(sel.to);
      const left = Math.min(start.left, end.left);
      const right = Math.max(start.right, end.right);
      const top = Math.min(start.top, end.top);
      setToolbarRect(
        new DOMRect(left, top, right - left, Math.max(start.bottom, end.bottom) - top)
      );
    },
  });

  useEffect(() => {
    if (registerCommit && editor) {
      registerCommit(() => {
        if (committedRef.current) return;
        if (editor.isDestroyed) {
          if (latestContentRef.current) {
            doCommit(latestContentRef.current.text, latestContentRef.current.segments);
          }
          return;
        }
        const { text, segments } = editorToSegments(editor, zoomRef.current);
        doCommit(text, segments);
      });
    }
    return () => {
      registerCommit?.(null);
      if (!committedRef.current && latestContentRef.current) {
        doCommit(latestContentRef.current.text, latestContentRef.current.segments);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const isBold = editor?.isActive('bold') ?? false;
  const isItalic = editor?.isActive('italic') ?? false;
  const isUnderline = editor?.isActive('underline') ?? false;
  const isStrike = editor?.isActive('strike') ?? false;

  // Active textStyle attributes for the floating toolbar display.
  const textStyleAttrs = (editor?.getAttributes('textStyle') ?? {}) as {
    fontSize?: string | null;
    fontFamily?: string | null;
  };
  // Built-in FontSize stores a CSS string of pt*zoom (e.g. '16px' at zoom 1);
  // parse and unscale so the input always shows PDF pt units.
  const fontSizeNum = textStyleAttrs.fontSize
    ? parseFloat(textStyleAttrs.fontSize) / zoom
    : NaN;
  const currentFontSize = Number.isFinite(fontSizeNum)
    ? fontSizeNum
    : block.fontSize;
  // fontFamily 属性可能是"PDF 原字体名, class CSS"的组合串,归一回
  // class CSS 让下拉框能正确显示当前选项。
  const rawFontFamily = textStyleAttrs.fontFamily || '';
  const currentFontFamily = (() => {
    if (!rawFontFamily) return '';
    for (const css of Object.values(FONT_CLASS_TO_CSS)) {
      if (rawFontFamily === css || rawFontFamily.includes(css)) return css;
    }
    return rawFontFamily;
  })();

  const btnBase: React.CSSProperties = {
    padding: '2px 6px',
    borderRadius: '3px',
    border: '1px solid #d1d5db',
    cursor: 'pointer',
    fontSize: '12px',
    minWidth: '24px',
    // Explicit text color: the toolbar background is always white, so use
    // dark gray for inactive and accent-blue for active. Without this the
    // buttons inherit the document's text color (light gray in dark mode)
    // and become invisible on the white toolbar.
    color: '#374151',
  };
  const btnActive: React.CSSProperties = {
    background: '#dbeafe',
    color: '#1e40af',
  };
  const btnInactive: React.CSSProperties = {
    background: '#fff',
  };

  const FONT_FAMILY_OPTIONS: { value: string; label: string }[] = [
    { value: FONT_CLASS_TO_CSS.sans, label: '无衬线' },
    { value: FONT_CLASS_TO_CSS.serif, label: '衬线' },
    { value: FONT_CLASS_TO_CSS.mono, label: '等宽' },
    { value: FONT_CLASS_TO_CSS['cjk-sans'], label: '中文无衬线' },
    { value: FONT_CLASS_TO_CSS['cjk-serif'], label: '中文衬线' },
  ];

  return (
    <div className="flex min-h-full w-full flex-col bg-inherit">
      <EditorContent
        editor={editor}
        className="tiptap-edit-area flex-1 overflow-visible"
        style={{ outline: 'none' }}
      />
      {toolbarRect && (
        <div
          ref={toolbarRef}
          style={{
            position: 'fixed',
            top: Math.max(4, toolbarRect.top - 36),
            left: toolbarRect.left + toolbarRect.width / 2,
            transform: 'translateX(-50%)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
            padding: '3px 6px',
            background: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
            color: '#374151',
          }}
        >
          <button type="button" title="粗体"
            style={{ ...btnBase, fontWeight: 700, ...(isBold ? btnActive : btnInactive) }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >B</button>
          <button type="button" title="斜体"
            style={{ ...btnBase, fontStyle: 'italic', ...(isItalic ? btnActive : btnInactive) }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >I</button>
          <button type="button" title="下划线"
            style={{ ...btnBase, textDecoration: 'underline', ...(isUnderline ? btnActive : btnInactive) }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
          >U</button>
          <button type="button" title="删除线"
            style={{ ...btnBase, textDecoration: 'line-through', ...(isStrike ? btnActive : btnInactive) }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor?.chain().focus().toggleStrike().run()}
          >S</button>
          <input
            type="color"
            title="文字颜色"
            style={{ width: '24px', height: '24px', border: '1px solid #d1d5db', borderRadius: '3px', cursor: 'pointer', padding: 0 }}
            onMouseDown={(e) => e.preventDefault()}
            onChange={(e) => editor?.chain().focus().setColor(e.target.value).run()}
          />
          <div style={{ width: '1px', height: '18px', background: '#d1d5db', margin: '0 2px' }} />
          <label
            title="字号"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '2px',
              fontSize: '12px',
              color: '#374151',
            }}
          >
            <span style={{ padding: '0 2px' }}>A</span>
            <input
              type="number"
              min={6}
              max={144}
              value={currentFontSize}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) {
                  // 输入的是 PDF pt 单位,存入 mark 时乘 zoom。
                  editor?.chain().focus().setFontSize(`${Math.max(6, Math.min(144, v)) * zoom}px`).run();
                }
              }}
              style={{
                width: '44px',
                height: '22px',
                padding: '0 4px',
                border: '1px solid #d1d5db',
                borderRadius: '3px',
                fontSize: '12px',
                textAlign: 'center',
                color: '#374151',
                background: '#fff',
              }}
            />
          </label>
          <select
            title="字体"
            value={currentFontFamily}
            onChange={(e) => {
              const v = e.target.value;
              if (v) {
                editor?.chain().focus().setFontFamily(v).run();
              } else {
                editor?.chain().focus().unsetFontFamily().run();
              }
            }}
            style={{
              height: '22px',
              padding: '0 4px',
              border: '1px solid #d1d5db',
              borderRadius: '3px',
              fontSize: '12px',
              cursor: 'pointer',
              maxWidth: '110px',
              color: '#374151',
              background: '#fff',
            }}
          >
            <option value="">默认字体</option>
            {FONT_FAMILY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
