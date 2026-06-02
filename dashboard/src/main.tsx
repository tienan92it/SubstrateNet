import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GlobalApp } from './GlobalApp';
import type { DashboardSnapshot, GlobalDashboardSnapshot } from './types';
import './styles.css';

type AnySnapshot = DashboardSnapshot | GlobalDashboardSnapshot | null;
const snapshot = (window as unknown as { __SUBNET_GRAPH__: AnySnapshot }).__SUBNET_GRAPH__;

function isGlobal(s: AnySnapshot): s is GlobalDashboardSnapshot {
  return !!s && (s as GlobalDashboardSnapshot).meta?.mode === 'global';
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    {snapshot
      ? (isGlobal(snapshot)
          ? <GlobalApp snapshot={snapshot} />
          : <App snapshot={snapshot as DashboardSnapshot} />)
      : <div className="empty">No graph data. Generate with <code>subnet dashboard</code>.</div>}
  </React.StrictMode>,
);
