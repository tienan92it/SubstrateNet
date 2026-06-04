import { describe, it, expect } from 'vitest';
import { isDiagramFile, extractDrawioLabels, extractExcalidrawText, extractDiagramText } from '../../src/ingest/diagrams.js';

describe('diagram detection + text extraction', () => {
  it('recognizes diagram extensions', () => {
    expect(isDiagramFile('/p/flow.mmd')).toBe(true);
    expect(isDiagramFile('/p/arch.drawio')).toBe(true);
    expect(isDiagramFile('/p/board.excalidraw')).toBe(true);
    expect(isDiagramFile('/p/seq.puml')).toBe(true);
    expect(isDiagramFile('/p/index.ts')).toBe(false);
  });

  it('extracts node labels from draw.io XML', () => {
    const xml = `<mxGraphModel><root>
      <mxCell value="Login Service" /><mxCell value="&lt;b&gt;Payments&lt;/b&gt;" /><mxCell value="" />
    </root></mxGraphModel>`;
    const out = extractDrawioLabels(xml);
    expect(out).toContain('Login Service');
    expect(out).toContain('Payments');
  });

  it('extracts text from excalidraw JSON', () => {
    const json = JSON.stringify({ elements: [
      { type: 'text', text: 'Auth flow' },
      { type: 'rectangle' },
      { type: 'text', text: 'KYC' },
    ] });
    const out = extractExcalidrawText(json);
    expect(out.split('\n').sort()).toEqual(['Auth flow', 'KYC']);
  });

  it('keeps mermaid source verbatim', () => {
    const mmd = 'graph TD; A-->B;';
    expect(extractDiagramText('/p/x.mmd', mmd)).toBe(mmd);
  });
});
