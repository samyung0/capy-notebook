import comicNeue from '@fontsource/comic-neue/files/comic-neue-latin-400-normal.woff2?url';
import comicNeueBold from '@fontsource/comic-neue/files/comic-neue-latin-700-normal.woff2?url';
import type { MermaidConfig } from 'mermaid';
import excalifont from '@/assets/fonts/Excalifont-Latin.woff2?url';
import type { MermaidTheme } from './mermaidThemes';

export interface MermaidFont {
  family: string;
  url: string;
  weight?: string;
}

export interface MermaidPreset {
  config: MermaidConfig;
  /** Loaded before rendering, because mermaid measures labels as it draws. */
  fonts?: MermaidFont[];
  /** Hand-drawn look: strokes reference the roughen filters added after rendering. */
  roughen?: true;
}

const EXCALIFONT: MermaidFont = { family: 'Excalifont', url: excalifont };
const COMIC_NEUE: MermaidFont[] = [
  { family: 'Comic Neue', url: comicNeue, weight: '400' },
  { family: 'Comic Neue', url: comicNeueBold, weight: '700' },
];

/**
 * Presets ported verbatim from gotoailab/modern_mermaid src/utils/themes.ts at
 * a021cbce37fc; Kawaii swaps Comic Sans MS for the loadable Comic Neue.
 * MIT License, Copyright (c) 2024 Modern Mermaid Team.
 */
export const MERMAID_PRESETS: Record<MermaidTheme, MermaidPreset> = {
  brutalist: {
    config: {
      theme: 'base',
      themeCSS: `
        /* Brutalist/Neobrutalism - Hard shadows and bold borders */
        
        /* Flowchart nodes - Hard shadow effect */
        .node rect, .node polygon {
          fill: #ffffff !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 4px !important;
          ry: 4px !important;
          /* Hard shadow simulation using double drop-shadow */
          filter: 
            drop-shadow(6px 6px 0px #000000);
        }

        .node circle {
          fill: #ffffff !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 4px !important;
          ry: 4px !important;
        }
        
        .node .label {
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
          fill: #000000 !important;
          font-size: 16px;
        }
        
        /* Connection lines - Bold and straight */
        .edgePath .path {
          stroke: #000000 !important;
          stroke-width: 3px !important;
          stroke-linecap: square;
        }
        
        .arrowheadPath {
          fill: #000000 !important;
          stroke: #000000 !important;
        }
        
        .edgeLabel {
          background-color: #f6f3e9 !important;
          color: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-size: 14px;
          font-weight: 700;
        }
        
        /* Color accent nodes */
        .node:nth-child(2n) rect,
        .node:nth-child(2n) circle,
        .node:nth-child(2n) polygon {
          fill: #FFE66D !important;
        }
        
        .node:nth-child(3n) rect,
        .node:nth-child(3n) circle,
        .node:nth-child(3n) polygon {
          fill: #4ECDC4 !important;
        }
        
        .node:nth-child(5n) rect,
        .node:nth-child(5n) circle,
        .node:nth-child(5n) polygon {
          fill: #FF6B35 !important;
        }
        
        /* Sequence Diagram - Brutalist style */
        /* Actor boxes - Only shadow on rect, not text */
        .actor rect {
          fill: #ffffff !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 4px !important;
          ry: 4px !important;
          filter: drop-shadow(6px 6px 0px #000000);
        }
        
        .actor {
          fill: #ffffff !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 4px !important;
          ry: 4px !important;
        }
        
        .actor text {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        
        .actor-line {
          stroke: #000000 !important;
          stroke-width: 3px !important;
        }
        
        .activation0, .activation1, .activation2 {
          fill: #FFE66D !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          filter: drop-shadow(5px 5px 0px #000000);
        }
        
        .messageLine0, .messageLine1 {
          stroke: #000000 !important;
          stroke-width: 3px !important;
          stroke-linecap: square;
        }
        
        .messageText {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
          font-size: 14px;
        }
        
        #arrowhead path, .arrowheadPath {
          fill: #000000 !important;
          stroke: #000000 !important;
        }
        
        /* Note boxes - Bright yellow with hard shadow */
        .note {
          fill: #FFE66D !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 4px !important;
          ry: 4px !important;
          filter: drop-shadow(6px 6px 0px #000000);
        }
        
        .noteText {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        
        /* Loop/Alt/Opt boxes - Orange accent */
        .labelBox {
          fill: #FF6B35 !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 4px !important;
          ry: 4px !important;
          filter: drop-shadow(6px 6px 0px #000000);
        }
        
        .labelText, .loopText {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        
        .loopLine {
          stroke: #000000 !important;
          stroke-width: 3px !important;
        }
        
        /* Cluster/Subgraph styling */
        .cluster rect {
          fill: #4ECDC4 !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 4px !important;
          ry: 4px !important;
          filter: drop-shadow(8px 8px 0px #000000);
        }
        
        .cluster text {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 900;
        }
        
        /* Class Diagram - Brutalist style with hard shadows */
        .classGroup rect {
          fill: #ffffff !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 4px !important;
          ry: 4px !important;
          filter: drop-shadow(6px 6px 0px #000000);
        }
        
        .classLabel .label,
        .classLabel text {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        
        .relationshipLine {
          stroke: #000000 !important;
          stroke-width: 3px !important;
        }
        
        .relationshipLabelBox {
          fill: #FFE66D !important;
          stroke: #000000 !important;
          stroke-width: 2px !important;
          filter: drop-shadow(4px 4px 0px #000000);
        }
        
        /* State diagram - Brutalist style with hard shadows */
        .statediagram-state rect,
        .statediagram-state .state-inner {
          fill: #ffffff !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 4px !important;
          ry: 4px !important;
          filter: drop-shadow(6px 6px 0px #000000);
        }
        
        /* State diagram start/end circles - smaller shadow offset */
        .start-state circle,
        .end-state circle {
          fill: #000000 !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          filter: drop-shadow(3px 3px 0px #000000) !important;
        }
        
        .statediagram-state circle {
          stroke: #000000 !important;
          stroke-width: 3px !important;
        }
        
        .stateLabel text,
        .statediagram-state text {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        
        .transition {
          stroke: #000000 !important;
          stroke-width: 3px !important;
        }

        .classDiagram .node.default {
          filter: drop-shadow(6px 6px 0px #000000);
        }
        
        /* ER Diagram - Brutalist style */
        .er.entityBox {
          fill: #ffffff !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          filter: drop-shadow(6px 6px 0px #000000);
        }
        
        .er.relationshipLabelBox {
          fill: #FFE66D !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          filter: drop-shadow(4px 4px 0px #000000);
        }
        
        .er.entityLabel,
        .er.relationshipLabel {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        
        .er .relationshipLine {
          stroke: #000000 !important;
          stroke-width: 3px !important;
        }
        
        /* Gantt chart */
        .titleText {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 900;
        }
        
        .sectionTitle {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        
        .taskText, .taskTextOutsideRight, .taskTextOutsideLeft {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        
        .task0, .task1, .task2, .task3 {
          stroke: #000000 !important;
          stroke-width: 3px !important;
          filter: drop-shadow(5px 5px 0px #000000);
        }
        
        /* Pie chart */
        .pieCircle {
          stroke: #000000 !important;
          stroke-width: 3px !important;
        }
        
        .pieTitleText {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 900;
        }
        
        .slice {
          stroke: #000000 !important;
          stroke-width: 3px !important;
        }
        
        .legendText {
          fill: #000000 !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        
        /* XYChart styles - Bold brutalist colors */
        .line-plot-0 path {
          stroke: #000000 !important;
          stroke-width: 4px !important;
          stroke-linecap: square;
        }
        .line-plot-1 path {
          stroke: #FF6B35 !important;
          stroke-width: 4px !important;
          stroke-linecap: square;
        }
        .line-plot-2 path {
          stroke: #4ECDC4 !important;
          stroke-width: 4px !important;
          stroke-linecap: square;
        }
        .bar-plot-0 rect {
          fill: #FFE66D !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 2px !important;
          filter: drop-shadow(6px 6px 0px #000000);
        }
        .bar-plot-1 rect {
          fill: #FF6B35 !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 2px !important;
          filter: drop-shadow(6px 6px 0px #000000);
        }
        .bar-plot-2 rect {
          fill: #4ECDC4 !important;
          stroke: #000000 !important;
          stroke-width: 3px !important;
          rx: 2px !important;
          filter: drop-shadow(6px 6px 0px #000000);
        }
        .ticks path {
          stroke: #000000 !important;
          stroke-width: 2px !important;
        }
        .chart-title text {
          fill: #000000 !important;
          font-weight: 900 !important;
          font-size: 20px !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
        }
        .left-axis .label text, .bottom-axis .label text {
          fill: #000000 !important;
          font-size: 14px !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
        .left-axis .title text, .bottom-axis .title text {
          fill: #000000 !important;
          font-size: 16px !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 900;
        }
        .legend text {
          fill: #000000 !important;
          font-size: 14px !important;
          font-family: "Arial", "Helvetica", "Noto Sans SC", sans-serif;
          font-weight: 700;
        }
      `,
      themeVariables: {
        background: '#f6f3e9',
        fontFamily: '"Arial", "Helvetica", "Noto Sans SC", sans-serif',
        fontSize: '16px',
        lineColor: '#000000',
        primaryBorderColor: '#000000',
        primaryColor: '#ffffff',
        primaryTextColor: '#000000',
        secondaryColor: '#FFE66D',
        tertiaryColor: '#FF6B35',
      },
    },
  },
  handDrawn: {
    config: {
      theme: 'base',
      themeCSS: `
        /* Hand-drawn sketch style */
        /* Global text styling */
        .titleText, .sectionTitle, .taskText, .taskTextOutsideRight, .taskTextOutsideLeft, 
        .legendText, text.actor, .pieTitleText, text.legend {
            fill: #1a1a1a !important;
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 600;
        }
        
        /* Flowchart nodes - rough hand-drawn style */
        .node rect, .node circle, .node polygon {
            fill: #ffffff !important;
            stroke: #1a1a1a !important;
            stroke-width: 2.8px !important;
            rx: 8px !important;
            ry: 8px !important;
            /* Simulate hand-drawn with slight irregularity */
            filter: url(#roughen) drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.15));
        }
        
        .node .label {
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 600;
            font-size: 18px;
            fill: #1a1a1a !important;
        }
        
        /* Hand-drawn lines for connections */
        .edgePath .path {
            stroke: #1a1a1a !important;
            stroke-width: 2.8px !important;
            stroke-linecap: round;
            stroke-linejoin: round;
            fill: none !important;
            filter: url(#roughen-line);
        }
        
        .arrowheadPath {
            fill: #1a1a1a !important;
            stroke: #1a1a1a !important;
            stroke-width: 2px !important;
        }
        
        .edgeLabel {
            background-color: #fffef9 !important;
            color: #1a1a1a !important;
            font-family: "Excalifont", "Xiaolai", cursive;
            font-size: 16px;
            font-weight: 600;
            padding: 4px 8px;
        }
        
        /* Sequence Diagram - Hand-drawn style */
        .actor {
            fill: #ffffff !important;
            stroke: #1a1a1a !important;
            stroke-width: 2.8px !important;
            rx: 8px !important;
            ry: 8px !important;
            filter: url(#roughen) drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.15));
        }
        
        .actor text {
            fill: #1a1a1a !important;
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 600;
            font-size: 18px;
        }
        
        .actor-line {
            stroke: #1a1a1a !important;
            stroke-width: 2.5px !important;
            stroke-dasharray: 8 4 !important;
            stroke-linecap: round;
            filter: url(#roughen-line);
        }
        
        .activation0, .activation1, .activation2 {
            fill: #fff9e6 !important;
            stroke: #1a1a1a !important;
            stroke-width: 2.8px !important;
            filter: url(#roughen);
        }
        
        .messageLine0, .messageLine1 {
            stroke: #1a1a1a !important;
            stroke-width: 2.8px !important;
            stroke-linecap: round;
            filter: url(#roughen-line);
        }
        
        .messageText {
            fill: #1a1a1a !important;
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 600;
            font-size: 16px;
        }
        
        #arrowhead path, .arrowheadPath {
            fill: #1a1a1a !important;
            stroke: #1a1a1a !important;
        }
        
        /* Note boxes - sketchy style */
        .note {
            fill: #fffacd !important;
            stroke: #1a1a1a !important;
            stroke-width: 2.8px !important;
            rx: 8px !important;
            ry: 8px !important;
            filter: url(#roughen) drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.15));
        }
        
        .noteText {
            fill: #1a1a1a !important;
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 600;
            font-size: 16px;
        }
        
        /* Loop/Alt/Opt boxes */
        .labelBox {
            fill: #ffe8cc !important;
            stroke: #1a1a1a !important;
            stroke-width: 2.8px !important;
            rx: 8px !important;
            ry: 8px !important;
            filter: url(#roughen) drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.15));
        }
        
        .labelText, .loopText {
            fill: #1a1a1a !important;
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 700;
            font-size: 16px;
        }
        
        .loopLine {
            stroke: #1a1a1a !important;
            stroke-width: 2.8px !important;
            stroke-dasharray: 8 4 !important;
            stroke-linecap: round;
            filter: url(#roughen-line);
        }
        
        /* Class diagram */
        .classLabel .label {
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 700;
            fill: #1a1a1a !important;
        }
        
        /* State diagram */
        .stateLabel .label-text {
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 700;
            fill: #1a1a1a !important;
        }
        
        /* ER Diagram */
        .er.entityLabel, .er.relationshipLabel {
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 700;
            fill: #1a1a1a !important;
        }
        
        /* Gantt chart */
        .grid .tick text {
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 600;
            fill: #1a1a1a !important;
        }
        
        /* Pie chart */
        .slice text {
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 700;
            fill: #1a1a1a !important;
        }
        
        /* Git graph */
        .commit-label {
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 600;
            fill: #1a1a1a !important;
        }
        
        /* Cluster/subgraph styling */
        .cluster rect {
            fill: #fff9e6 !important;
            stroke: #1a1a1a !important;
            stroke-width: 2.8px !important;
            stroke-dasharray: 8 4 !important;
            rx: 8px !important;
            ry: 8px !important;
            filter: url(#roughen) drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.15));
        }
        
        .cluster text {
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 700;
            fill: #1a1a1a !important;
        }
        
        /* XYChart styles - Natural ink palette */
        .line-plot-0 path {
            stroke: #5D6D7E !important;
            stroke-width: 3px !important;
            stroke-linecap: round;
            stroke-linejoin: round;
            filter: url(#roughen-line) drop-shadow(1px 1px 2px rgba(0, 0, 0, 0.1));
        }
        .line-plot-1 path {
            stroke: #7E6B5D !important;
            stroke-width: 3px !important;
            stroke-linecap: round;
            stroke-linejoin: round;
            filter: url(#roughen-line) drop-shadow(1px 1px 2px rgba(0, 0, 0, 0.1));
        }
        .line-plot-2 path {
            stroke: #6B7E5D !important;
            stroke-width: 3px !important;
            stroke-linecap: round;
            stroke-linejoin: round;
            filter: url(#roughen-line) drop-shadow(1px 1px 2px rgba(0, 0, 0, 0.1));
        }
        .bar-plot-0 rect {
            fill: #E8EBF0 !important;
            stroke: #5D6D7E !important;
            stroke-width: 2.8px !important;
            rx: 4px !important;
            filter: url(#roughen) drop-shadow(2px 2px 3px rgba(0, 0, 0, 0.15));
        }
        .bar-plot-1 rect {
            fill: #F0EBE8 !important;
            stroke: #7E6B5D !important;
            stroke-width: 2.8px !important;
            rx: 4px !important;
            filter: url(#roughen) drop-shadow(2px 2px 3px rgba(0, 0, 0, 0.15));
        }
        .bar-plot-2 rect {
            fill: #EBF0E8 !important;
            stroke: #6B7E5D !important;
            stroke-width: 2.8px !important;
            rx: 4px !important;
            filter: url(#roughen) drop-shadow(2px 2px 3px rgba(0, 0, 0, 0.15));
        }
        .ticks path {
            stroke: #1a1a1a !important; 
            stroke-width: 1.5px !important;
            opacity: 0.4;
        }
        .chart-title text {
            fill: #1a1a1a !important; 
            font-weight: 700 !important;
            font-size: 20px !important;
            font-family: "Excalifont", "Xiaolai", cursive;
        }
        .left-axis .title text, .bottom-axis .title text {
            fill: #1a1a1a !important; 
            font-size: 16px !important;
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 600;
        }
        .legend text {
            fill: #1a1a1a !important; 
            font-size: 14px !important;
            font-family: "Excalifont", "Xiaolai", cursive;
            font-weight: 600;
        }
      `,
      themeVariables: {
        background: '#fffef9',
        fontFamily: '"Excalifont", "Xiaolai", cursive',
        fontSize: '18px',
        lineColor: '#1a1a1a',
        primaryBorderColor: '#1a1a1a',
        primaryColor: '#ffffff',
        primaryTextColor: '#1a1a1a',
        secondaryColor: '#fff9e6',
        tertiaryColor: '#ffe8cc',
      },
    },
    fonts: [EXCALIFONT],
    roughen: true,
  },
  kawaii: {
    config: {
      theme: 'base',
      themeCSS: `
        /* 全局样式 - 可爱粉色主题 */
        .node rect, .node circle, .node polygon, .node path {
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          fill: #ffe9f5 !important;
          rx: 20px !important;
          ry: 20px !important;
          filter: drop-shadow(0 6px 12px rgba(255, 107, 157, 0.25));
        }
        
        .edgePath .path {
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
          stroke-linecap: round !important;
          filter: drop-shadow(0 2px 4px rgba(255, 107, 157, 0.2));
        }
        
        .arrowheadPath {
          fill: #ff6b9d !important;
          stroke: #ff6b9d !important;
        }
        
        .edgeLabel {
          color: #a8197d !important;
          font-weight: 600;
        }
        
        .edgeLabel rect {
          fill: #fff5f8 !important;
          stroke: #ffb3d1 !important;
          stroke-width: 2px !important;
          rx: 15px !important;
          filter: drop-shadow(0 2px 6px rgba(255, 107, 157, 0.2));
        }
        
        .edgeLabel .label,
        .edgeLabel text {
          fill: #a8197d !important;
          font-weight: 600;
        }
        
        .label, .nodeLabel {
          color: #a8197d !important;
          font-weight: 600;
        }
        
        /* 流程图节点样式 */
        .flowchart-link {
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
        }
        
        /* 序列图样式 */
        .actor {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          rx: 20px !important;
          ry: 20px !important;
          filter: drop-shadow(0 6px 12px rgba(255, 107, 157, 0.25));
        }
        
        .actor text {
          fill: #a8197d !important;
          font-weight: 600;
        }
        
        .actor-line {
          stroke: #ffb3d1 !important;
          stroke-width: 2px !important;
          stroke-dasharray: 6 6;
        }
        
        .activation0, .activation1, .activation2 {
          fill: rgba(255, 180, 209, 0.3) !important;
          stroke: #ff9ec7 !important;
          stroke-width: 2.5px !important;
          rx: 15px !important;
        }
        
        .messageLine0, .messageLine1 {
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
          stroke-linecap: round !important;
        }
        
        .note {
          fill: #fff0f6 !important;
          stroke: #ffc4e1 !important;
          stroke-width: 3px !important;
          rx: 18px !important;
          ry: 18px !important;
          filter: drop-shadow(0 4px 8px rgba(255, 196, 225, 0.3));
        }
        
        .noteText {
          fill: #c7267d !important;
          font-weight: 600;
        }
        
        .labelBox {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 2.5px !important;
          rx: 15px !important;
          ry: 15px !important;
        }
        
        .labelText, .loopText {
          fill: #a8197d !important;
          font-weight: 600;
        }
        
        /* 类图样式 */
        .classGroup rect {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          rx: 18px !important;
          filter: drop-shadow(0 6px 12px rgba(255, 107, 157, 0.25));
        }
        
        .classGroup line {
          stroke: #ffb3d1 !important;
          stroke-width: 2px !important;
        }
        
        .classGroup text {
          fill: #a8197d !important;
          font-weight: 600;
        }
        
        .classLabel .box {
          fill: #fff0f6 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 2.5px !important;
          rx: 15px !important;
        }
        
        .classLabel .label {
          fill: #a8197d !important;
          font-weight: 700;
        }
        
        .relation {
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
        }
        
        /* 状态图样式 */
        .stateGroup rect {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          rx: 20px !important;
          ry: 20px !important;
          filter: drop-shadow(0 6px 12px rgba(255, 107, 157, 0.25));
        }
        
        .stateGroup text {
          fill: #a8197d !important;
          font-weight: 600;
        }
        
        .transition {
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
        }
        
        .stateLabel .box {
          fill: #fff0f6 !important;
          stroke: #ff9ec7 !important;
          rx: 15px !important;
        }
        
        .state-start circle, .state-end circle {
          fill: #ff9ec7 !important;
          stroke: #ff6b9d !important;
          stroke-width: 3px !important;
          filter: drop-shadow(0 4px 8px rgba(255, 158, 199, 0.4));
        }
        
        /* 甘特图样式 */
        .grid .tick line {
          stroke: rgba(255, 158, 199, 0.3) !important;
          stroke-width: 1px !important;
        }
        
        .grid .tick text {
          fill: #a8197d !important;
          font-size: 12px !important;
          font-weight: 600;
        }
        
        .taskText {
          fill: #a8197d !important;
          font-weight: 700;
        }
        
        .taskTextOutsideRight, .taskTextOutsideLeft {
          fill: #a8197d !important;
          font-weight: 700;
        }
        
        .task {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 2.5px !important;
          rx: 12px !important;
          filter: drop-shadow(0 4px 8px rgba(255, 107, 157, 0.2));
        }
        
        .task0, .task1, .task2, .task3 {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 2.5px !important;
        }
        
        .taskDone0, .taskDone1, .taskDone2, .taskDone3 {
          fill: #ffc4e1 !important;
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
        }
        
        .activeTask0, .activeTask1, .activeTask2, .activeTask3 {
          fill: #ffb3d1 !important;
          stroke: #ff5892 !important;
          stroke-width: 3px !important;
        }
        
        .section0, .section1, .section2, .section3 {
          fill: rgba(255, 228, 241, 0.5) !important;
        }
        
        .sectionTitle {
          fill: #c7267d !important;
          font-weight: 700;
          font-size: 16px !important;
        }
        
        .today {
          stroke: #ff5892 !important;
          stroke-width: 3px !important;
          stroke-dasharray: 6 6;
          fill: rgba(255, 88, 146, 0.15) !important;
        }
        
        /* 饼图样式 */
        .pieCircle {
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
        }
        
        .pieTitleText {
          fill: #a8197d !important;
          font-weight: 700;
          font-size: 20px !important;
        }
        
        .slice {
          stroke: #ff9ec7 !important;
          stroke-width: 2.5px !important;
          filter: drop-shadow(0 4px 8px rgba(255, 107, 157, 0.2));
        }
        
        .pieOuterCircle {
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          fill: none !important;
        }
        
        .legend text {
          fill: #a8197d !important;
          font-size: 13px !important;
          font-weight: 600;
        }
        
        .legend rect {
          stroke: #ff9ec7 !important;
          stroke-width: 2px !important;
          rx: 8px !important;
        }
        
        /* XY图表样式 - 可爱配色 */
        .line-plot-0 path {
          stroke: #ff6b9d !important;
          stroke-width: 3.5px !important;
          stroke-linecap: round !important;
          stroke-linejoin: round !important;
          filter: drop-shadow(0 3px 6px rgba(255, 107, 157, 0.3));
        }
        
        .line-plot-1 path {
          stroke: #ff9ec7 !important;
          stroke-width: 3.5px !important;
          stroke-linecap: round !important;
          stroke-linejoin: round !important;
          filter: drop-shadow(0 3px 6px rgba(255, 158, 199, 0.3));
        }
        
        .line-plot-2 path {
          stroke: #ffc4e1 !important;
          stroke-width: 3.5px !important;
          stroke-linecap: round !important;
          stroke-linejoin: round !important;
          filter: drop-shadow(0 3px 6px rgba(255, 196, 225, 0.3));
        }
        
        .bar-plot-0 rect {
          fill: rgba(255, 107, 157, 0.5) !important;
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
          rx: 12px !important;
          filter: drop-shadow(0 4px 8px rgba(255, 107, 157, 0.2));
        }
        
        .bar-plot-1 rect {
          fill: rgba(255, 158, 199, 0.5) !important;
          stroke: #ff9ec7 !important;
          stroke-width: 2.5px !important;
          rx: 12px !important;
          filter: drop-shadow(0 4px 8px rgba(255, 158, 199, 0.2));
        }
        
        .bar-plot-2 rect {
          fill: rgba(255, 196, 225, 0.5) !important;
          stroke: #ffc4e1 !important;
          stroke-width: 2.5px !important;
          rx: 12px !important;
          filter: drop-shadow(0 4px 8px rgba(255, 196, 225, 0.2));
        }
        
        .chart-title text {
          fill: #a8197d !important;
          font-weight: 700 !important;
          font-size: 20px !important;
        }
        
        .left-axis .label text, .bottom-axis .label text {
          fill: #a8197d !important;
          font-size: 13px !important;
          font-weight: 600;
        }
        
        .left-axis .title text {
          fill: #c7267d !important;
          font-size: 16px !important;
          font-weight: 700;
        }
        
        .bottom-axis .title text {
          fill: #c7267d !important;
          font-size: 16px !important;
          font-weight: 700;
        }
        
        .left-axis line, .bottom-axis line {
          stroke: #ffb3d1 !important;
          stroke-width: 1.5px !important;
        }
        
        .grid line {
          stroke: rgba(255, 179, 209, 0.3) !important;
        }
        
        /* ER图样式 */
        .er.entityBox {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          rx: 18px !important;
          filter: drop-shadow(0 6px 12px rgba(255, 107, 157, 0.25));
        }
        
        .er.entityLabel {
          fill: #a8197d !important;
          font-weight: 700;
        }
        
        .er.relationshipLine {
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
        }
        
        .er.relationshipLabelBox {
          fill: #fff0f6 !important;
          stroke: #ffc4e1 !important;
          rx: 12px !important;
        }
        
        .er.relationshipLabel {
          fill: #c7267d !important;
          font-weight: 600;
        }
        
        .er.attributeBoxOdd {
          fill: rgba(255, 233, 245, 0.6) !important;
        }
        
        .er.attributeBoxEven {
          fill: rgba(255, 212, 229, 0.6) !important;
        }
        
        /* Journey图样式 */
        .journey-section {
          fill: rgba(255, 228, 241, 0.5) !important;
        }
        
        .journey-task {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          rx: 15px !important;
          filter: drop-shadow(0 4px 8px rgba(255, 107, 157, 0.25));
        }
        
        .journey-actor {
          fill: #ff9ec7 !important;
          stroke: #ff6b9d !important;
          stroke-width: 2px !important;
        }
        
        .journey-label {
          fill: #a8197d !important;
          font-weight: 600;
        }
        
        /* Mindmap样式 */
        .mindmap-node {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          rx: 20px !important;
          filter: drop-shadow(0 6px 12px rgba(255, 107, 157, 0.25));
        }
        
        .mindmap-node-text {
          fill: #a8197d !important;
          font-weight: 600;
        }
        
        .mindmap-edge {
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
          stroke-linecap: round !important;
        }
        
        /* 通用文本样式 */
        text {
          fill: #a8197d !important;
        }
        
        tspan {
          fill: #a8197d !important;
        }
        
        /* Cluster/子图样式 */
        .cluster rect {
          fill: rgba(255, 212, 229, 0.4) !important;
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          stroke-dasharray: 8 8;
          rx: 25px !important;
          ry: 25px !important;
          filter: drop-shadow(0 4px 8px rgba(255, 107, 157, 0.15));
        }
        
        .cluster text {
          fill: #c7267d !important;
          font-weight: 700;
        }
        
        .cluster-label {
          fill: #c7267d !important;
          font-weight: 700;
        }
        
        /* Git图样式 */
        .commit-id, .commit-msg, .branch-label {
          fill: #a8197d !important;
          font-weight: 600;
        }
        
        .commit {
          fill: #ff9ec7 !important;
          stroke: #ff6b9d !important;
          stroke-width: 3px !important;
          r: 8px !important;
        }
        
        .branch {
          stroke: #ff6b9d !important;
          stroke-width: 2.5px !important;
          stroke-linecap: round !important;
        }
        
        /* 时间线样式 */
        .timeline-event {
          fill: #ffe9f5 !important;
          stroke: #ff9ec7 !important;
          stroke-width: 3px !important;
          rx: 18px !important;
        }
        
        .timeline-marker {
          fill: #ff9ec7 !important;
          stroke: #ff6b9d !important;
          stroke-width: 3px !important;
        }
      `,
      themeVariables: {
        background: '#fff5f8',
        clusterBkg: '#ffd4e5',
        clusterBorder: '#ff9ec7',
        edgeLabelBackground: '#fff5f8',
        fontFamily:
          '"Comic Neue", "Noto Sans SC", "Segoe UI", cursive, sans-serif',
        fontSize: '14px',
        lineColor: '#ff6b9d',
        mainBkg: '#ffe9f5',
        nodeBorder: '#ff9ec7',
        primaryBorderColor: '#ff9ec7',
        primaryColor: '#ffe9f5',
        primaryTextColor: '#a8197d',
        secondaryColor: '#ffd4e5',
        tertiaryColor: '#ffe4f1',
      },
    },
    fonts: COMIC_NEUE,
  },
  linearDark: {
    config: {
      theme: 'base',
      themeCSS: `
        .node rect, .node circle, .node polygon, .node path { stroke-width: 1.5px; }
        .edgePath .path { stroke-width: 1.5px; }
        
        /* XYChart styles - Elegant dark theme palette */
        .line-plot-0 path { stroke: #7B9BAE !important; stroke-width: 3px !important; } /* Cool steel blue */
        .line-plot-1 path { stroke: #8EAFA8 !important; stroke-width: 3px !important; } /* Misty teal */
        .line-plot-2 path { stroke: #D4A5A5 !important; stroke-width: 3px !important; } /* Muted mauve */
        .bar-plot-0 rect { fill: rgba(123, 155, 174, 0.3) !important; stroke: #7B9BAE !important; stroke-width: 1.5px !important; }
        .bar-plot-1 rect { fill: rgba(142, 175, 168, 0.3) !important; stroke: #8EAFA8 !important; stroke-width: 1.5px !important; }
        .bar-plot-2 rect { fill: rgba(212, 165, 165, 0.3) !important; stroke: #D4A5A5 !important; stroke-width: 1.5px !important; }
        .chart-title text { fill: #f4f4f5 !important; font-weight: 600 !important; font-size: 20px !important; }
        .left-axis .label text, .bottom-axis .label text { fill: #d4d4d8 !important; font-size: 14px !important; }
        .left-axis .title text { fill: #a1a1aa !important; font-size: 16px !important; }
        .bottom-axis .title text { fill: #a1a1aa !important; font-size: 16px !important; }
      `,
      themeVariables: {
        background: '#09090b',
        darkMode: true,
        fontFamily:
          '"Inter", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: '14px',
        lineColor: '#52525b',
        primaryBorderColor: '#27272a',
        primaryColor: '#18181b',
        primaryTextColor: '#f4f4f5',
        secondaryColor: '#27272a',
        tertiaryColor: '#27272a',
      },
    },
  },
  linearLight: {
    config: {
      theme: 'base',
      themeCSS: `
        .node rect, .node circle, .node polygon, .node path { stroke-width: 1.5px; }
        .edgePath .path { stroke-width: 1.5px; }
        .cluster rect { stroke-dasharray: 4 4; stroke: #d4d4d4; fill: #fafafa; }
        
        /* XYChart styles - Sophisticated muted tones */
        .line-plot-0 path { stroke: #5B7C99 !important; stroke-width: 3px !important; } /* Muted slate blue */
        .line-plot-1 path { stroke: #6B9080 !important; stroke-width: 3px !important; } /* Sage green */
        .line-plot-2 path { stroke: #C17C74 !important; stroke-width: 3px !important; } /* Dusty rose */
        .bar-plot-0 rect { fill: #A8C5DD !important; stroke: #5B7C99 !important; stroke-width: 1.5px !important; }
        .bar-plot-1 rect { fill: #B8CEC2 !important; stroke: #6B9080 !important; stroke-width: 1.5px !important; }
        .bar-plot-2 rect { fill: #E0BAB5 !important; stroke: #C17C74 !important; stroke-width: 1.5px !important; }
        .chart-title text { fill: #171717 !important; font-weight: 600 !important; font-size: 20px !important; }
        .left-axis .label text, .bottom-axis .label text { fill: #171717 !important; font-size: 14px !important; }
        .left-axis .title text { fill: #525252 !important; font-size: 16px !important; }
        .bottom-axis .title text { fill: #525252 !important; font-size: 16px !important; }
      `,
      themeVariables: {
        background: '#ffffff',
        fontFamily:
          '"Inter", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: '14px',
        lineColor: '#737373',
        primaryBorderColor: '#e5e5e5',
        primaryColor: '#ffffff',
        primaryTextColor: '#171717',
        secondaryColor: '#fafafa',
        tertiaryColor: '#f5f5f5',
      },
    },
  },
};

/** SVG filters Hand Drawn's CSS points at, prefixed so each diagram owns its copy. */
export function roughenFilters(prefix: string) {
  return `<defs><filter id="${prefix}roughen" x="-25%" y="-25%" width="150%" height="150%" filterUnits="objectBoundingBox"><feTurbulence type="fractalNoise" baseFrequency="0.04 0.04" numOctaves="3" result="noise" seed="2"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="2" xChannelSelector="R" yChannelSelector="G" result="displaced"/><feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves="2" result="noise2" seed="5"/><feDisplacementMap in="displaced" in2="noise2" scale="1" xChannelSelector="R" yChannelSelector="G"/></filter><filter id="${prefix}roughen-line" x="-30%" y="-30%" width="160%" height="160%" filterUnits="objectBoundingBox"><feTurbulence type="fractalNoise" baseFrequency="0.05 0.05" numOctaves="3" result="noise" seed="1"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.8" xChannelSelector="R" yChannelSelector="G" result="displaced"/><feTurbulence type="fractalNoise" baseFrequency="0.02 0.02" numOctaves="2" result="noise2" seed="3"/><feDisplacementMap in="displaced" in2="noise2" scale="0.8" xChannelSelector="R" yChannelSelector="G"/></filter></defs>`;
}
