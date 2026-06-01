import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { DashboardSnapshot } from './types';
import './styles.css';

const snapshot = (window as unknown as { __SUBNET_GRAPH__: DashboardSnapshot | null }).__SUBNET_GRAPH__;

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    {snapshot
      ? <App snapshot={snapshot} />
      : <div className="empty">No graph data. Generate with <code>subnet dashboard</code>.</div>}
  </React.StrictMode>,
);
