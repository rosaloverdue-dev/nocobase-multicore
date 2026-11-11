/**
 * A tiny stand-in for the antd components used by the settings page. It exists only so that the page can be rendered
 * and clicked through in a headless browser WITHOUT a NocoBase install (tests/ui/run.mjs). It mimics behaviour
 * (tables, modal, pop-confirm, inputs), not antd's look or its full API - the real check is on a NocoBase stand.
 */
import React, { useState } from 'react';

const cx = (...names: any[]) => names.filter(Boolean).join(' ');

export const Typography: any = {
  Title: ({ children, style }: any) => <h2 style={style}>{children}</h2>,
  Text: ({ children, type, strong, style }: any) => <span className={cx('txt', type && `txt-${type}`)} style={{ fontWeight: strong ? 600 : undefined, ...style }}>{children}</span>,
  Paragraph: ({ children, type, style }: any) => <p className={cx('txt', type && `txt-${type}`)} style={style}>{children}</p>,
};
export const Alert = ({ type = 'info', message, style }: any) => <div className={`alert alert-${type}`} role="alert" style={style}>{message}</div>;
export const Button = ({ children, onClick, disabled, loading, type, size }: any) => (
  <button className={cx('btn', type === 'primary' && 'btn-primary', size === 'small' && 'btn-small')} disabled={disabled || loading} onClick={onClick}>{loading ? '… ' : ''}{children}</button>
);
export const Card = ({ title, extra, children, style }: any) => (
  <section className="card" style={style}>
    {title || extra ? <header><b>{title}</b><span>{extra}</span></header> : null}
    <div className="card-body">{children}</div>
  </section>
);
export const Row = ({ children }: any) => <div className="row">{children}</div>;
export const Col = ({ children }: any) => <div className="col">{children}</div>;
export const Space = ({ children, direction, style }: any) => <div className={cx('space', direction === 'vertical' && 'space-v')} style={style}>{children}</div>;
export const Tag = ({ children, color }: any) => <span className={cx('tag', color && `tag-${color}`)}>{children}</span>;
export const Tooltip = ({ title, children }: any) => <span title={typeof title === 'string' ? title : undefined} data-tooltip={typeof title === 'string' ? title : undefined}>{children}</span>;
export const Statistic = ({ title, value, suffix, valueStyle }: any) => (
  <div className="stat"><div className="stat-title">{title}</div><div className="stat-value" style={valueStyle}>{typeof value === 'number' ? value.toLocaleString() : value} <small>{suffix}</small></div></div>
);
export const Switch = ({ checked, onChange }: any) => <input type="checkbox" role="switch" checked={Boolean(checked)} onChange={(e) => onChange?.(e.target.checked)} />;
export const Input = ({ value, onChange, placeholder, style }: any) => <input className="input" value={value ?? ''} placeholder={placeholder} style={style} onChange={onChange} />;
export const InputNumber = ({ value, onChange, min, max, step, disabled, placeholder, style }: any) => (
  <input className="input" type="number" value={value ?? ''} min={min} max={max} step={step} disabled={disabled} placeholder={placeholder} style={{ width: 90, ...style }}
    onChange={(e) => onChange?.(e.target.value === '' ? null : Number(e.target.value))} />
);
export const Select = ({ value, onChange, options, disabled, style }: any) => (
  <select className="input" value={value} disabled={disabled} style={style} onChange={(e) => onChange?.(e.target.value)}>
    {(options || []).map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
);
export const Modal = ({ open, title, children, onCancel, width }: any) =>
  open ? (
    <div className="modal-mask">
      <div className="modal" role="dialog" style={{ width }}>
        <header><b>{title}</b><button aria-label="close" className="btn btn-small" onClick={onCancel}>×</button></header>
        <div className="card-body">{children}</div>
      </div>
    </div>
  ) : null;
export const Popconfirm = ({ title, okText, cancelText, onConfirm, children }: any) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="popconfirm">
      <span onClick={() => setOpen(true)}>{children}</span>
      {open ? (
        <span className="pop" role="tooltip">
          <span>{title}</span>
          <button className="btn btn-small" onClick={() => setOpen(false)}>{cancelText}</button>
          <button className="btn btn-small btn-primary" onClick={() => { setOpen(false); onConfirm?.(); }}>{okText}</button>
        </span>
      ) : null}
    </span>
  );
};
export const Table = ({ columns, dataSource, rowKey, pagination, loading }: any) => {
  const [page, setPage] = useState(0);
  const all = dataSource || [];
  const size = pagination && pagination.pageSize ? pagination.pageSize : all.length || 1;
  const pages = Math.max(1, Math.ceil(all.length / size));
  const rows = pagination ? all.slice(page * size, page * size + size) : all;
  const key = (r: any, i: number) => (typeof rowKey === 'function' ? rowKey(r) : rowKey ? r[rowKey] : i);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map((c: any, i: number) => <th key={i} style={{ width: c.width }}>{c.title}</th>)}</tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={columns.length}>…</td></tr> : null}
          {rows.map((r: any, i: number) => (
            <tr key={key(r, i)}>
              {columns.map((c: any, j: number) => <td key={j}>{c.render ? c.render(c.dataIndex ? r[c.dataIndex] : undefined, r, i) : c.dataIndex ? r[c.dataIndex] : null}</td>)}
            </tr>
          ))}
          {!loading && !rows.length ? <tr><td colSpan={columns.length} className="txt-secondary">—</td></tr> : null}
        </tbody>
      </table>
      {pagination && pages > 1 ? (
        <div className="pager">
          <button className="btn btn-small" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button> {page + 1} / {pages}{' '}
          <button className="btn btn-small" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>›</button>
        </div>
      ) : null}
    </div>
  );
};
const toast = (kind: string) => (text: string) => {
  (window as any).__toasts = [...((window as any).__toasts || []), `${kind}: ${text}`];
};
export const message = { success: toast('success'), error: toast('error'), info: toast('info'), warning: toast('warning') };
