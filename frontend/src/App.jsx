import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowLeftRight, BookOpen, Check, CheckCircle2, Download,
  ChevronDown, ChevronLeft, ChevronRight,
  FileSpreadsheet, Filter, GitCompare, HardDrive, History,
  LayoutDashboard, Loader2, Plus, RefreshCw, Save, Search, Settings2,
  ShieldCheck, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost, downloadExport, uploadFile } from './api.js';

const PAIR_SEPARATOR = ':::';
const pairId = (pair) => `${pair.left}${PAIR_SEPARATOR}${pair.right}`;
const displayDate = (value) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const formatNumber = (value) => Number(value || 0).toLocaleString();
const formatBytes = (value) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
const EXCEPTION_LABELS = {
  missing_value_source_a: 'Missing value · Source A', missing_value_source_b: 'Missing value · Source B',
  duplicate_key_source_a: 'Duplicate key · Source A', duplicate_key_source_b: 'Duplicate key · Source B',
  duplicate_row_source_a: 'Duplicate row · Source A', duplicate_row_source_b: 'Duplicate row · Source B',
  missing_matching_key_source_a: 'Missing key · Source A', missing_matching_key_source_b: 'Missing key · Source B',
  record_missing_in_source_a: 'Missing from Source A', record_missing_in_source_b: 'Missing from Source B',
  ambiguous_key: 'Ambiguous matching key', value_mismatch: 'Value mismatch',
  fuzzy_match_suggestion: 'Possible match suggestion', exception_details_truncated: 'Exception detail limit reached',
};
const humanize = (value) => EXCEPTION_LABELS[value] || (value || '').replaceAll('_', ' ');

function defaultRules(a, b) {
  if (!a || !b) return { keys: [{ left: '', right: '' }], compares: [] };
  const colsA = a.columns.map((c) => c.name);
  const colsB = b.columns.map((c) => c.name);
  const common = colsA.filter((column) => colsB.includes(column));
  const preferred = common.find((column) => ['account_id', 'accountid', 'record_id', 'id', 'customer_id'].includes(column.toLowerCase()));
  const key = preferred || common[0];
  const keys = key ? [{ left: key, right: key }] : [{ left: colsA[0] || '', right: colsB[0] || '' }];
  const compares = common.filter((column) => !keys.some((pair) => pair.left === column && pair.right === column))
    .map((column) => ({ left: column, right: column }));
  return { keys, compares };
}

function App() {
  const [view, setView] = useState('workspace');
  const [sourceA, setSourceA] = useState(null);
  const [sourceB, setSourceB] = useState(null);
  const [keyPairs, setKeyPairs] = useState([{ left: '', right: '' }]);
  const [comparePairs, setComparePairs] = useState([]);
  const [trimWhitespace, setTrimWhitespace] = useState(true);
  const [caseInsensitive, setCaseInsensitive] = useState(false);
  const [numericTolerance, setNumericTolerance] = useState('0');
  const [fuzzyEnabled, setFuzzyEnabled] = useState(false);
  const [fuzzyThreshold, setFuzzyThreshold] = useState(0.85);
  const [isWorking, setIsWorking] = useState(false);
  const [workingMessage, setWorkingMessage] = useState('');
  const [activeRun, setActiveRun] = useState(null);
  const [exceptionResult, setExceptionResult] = useState({ items: [], page: 1, pages: 0, total: 0 });
  const [filterType, setFilterType] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [history, setHistory] = useState([]);
  const [audit, setAudit] = useState([]);
  const [historyTab, setHistoryTab] = useState('runs');
  const [profiles, setProfiles] = useState([]);
  const [profileName, setProfileName] = useState('');
  const [showProfileInput, setShowProfileInput] = useState(false);
  const [notice, setNotice] = useState(null);
  const inputA = useRef(null);
  const inputB = useRef(null);

  const showNotice = (type, message) => setNotice({ type, message });
  const clearNotice = () => setNotice(null);

  const updateDataset = (side, dataset) => {
    const nextA = side === 'a' ? dataset : sourceA;
    const nextB = side === 'b' ? dataset : sourceB;
    if (side === 'a') setSourceA(dataset); else setSourceB(dataset);
    setActiveRun(null);
    if (nextA && nextB) {
      const defaults = defaultRules(nextA, nextB);
      setKeyPairs(defaults.keys);
      setComparePairs(defaults.compares);
    }
  };

  const handleUpload = async (side, file) => {
    if (!file) return;
    clearNotice();
    setIsWorking(true);
    setWorkingMessage(`Inspecting ${file.name}…`);
    try {
      const previous = side === 'a' ? sourceA : sourceB;
      const dataset = await uploadFile(file);
      if (previous && previous.upload_id !== dataset.upload_id) {
        try { await apiDelete(`/uploads/${previous.upload_id}`); } catch { /* Keep the new upload usable if old-copy cleanup fails. */ }
      }
      updateDataset(side, dataset);
      showNotice('success', `${dataset.filename} is ready — ${formatNumber(dataset.row_count)} rows and ${dataset.column_count} columns detected.`);
    } catch (error) {
      showNotice('error', error.message);
    } finally {
      setIsWorking(false);
      setWorkingMessage('');
    }
  };

  const handleDemo = async () => {
    clearNotice();
    setIsWorking(true);
    setWorkingMessage('Preparing synthetic demo datasets…');
    try {
      const demo = await apiPost('/demo', {});
      const newIds = new Set([demo.source_a.upload_id, demo.source_b.upload_id]);
      const obsolete = [sourceA, sourceB].filter((dataset) => dataset && !newIds.has(dataset.upload_id));
      await Promise.all(obsolete.map((dataset) => apiDelete(`/uploads/${dataset.upload_id}`).catch(() => null)));
      setSourceA(demo.source_a);
      setSourceB(demo.source_b);
      const defaults = defaultRules(demo.source_a, demo.source_b);
      setKeyPairs(defaults.keys);
      setComparePairs(defaults.compares);
      setActiveRun(null);
      setTrimWhitespace(true);
      setCaseInsensitive(false);
      setNumericTolerance('0');
      setFuzzyEnabled(true);
      setFuzzyThreshold(0.85);
      showNotice('success', 'Synthetic data loaded. Run the reconciliation to explore duplicates, missing records, and value mismatches.');
    } catch (error) {
      showNotice('error', error.message);
    } finally {
      setIsWorking(false);
      setWorkingMessage('');
    }
  };

  const handleSheetChange = async (side, sheetName) => {
    const dataset = side === 'a' ? sourceA : sourceB;
    if (!dataset || !sheetName) return;
    setIsWorking(true);
    setWorkingMessage(`Inspecting worksheet “${sheetName}”…`);
    try {
      const updated = await apiPatch(`/uploads/${dataset.upload_id}/sheet`, { sheet_name: sheetName });
      updateDataset(side, updated);
      showNotice('success', `Worksheet “${sheetName}” is ready.`);
    } catch (error) {
      showNotice('error', error.message);
    } finally {
      setIsWorking(false);
      setWorkingMessage('');
    }
  };

  const keyChange = (index, side, value) => {
    const next = keyPairs.map((pair, i) => i === index ? { ...pair, [side]: value } : pair);
    setKeyPairs(next);
    setComparePairs((current) => current.filter((pair) => !next.some((key) => pair.left === key.left || pair.right === key.right)));
  };

  const removeDataset = async (side) => {
    const dataset = side === 'a' ? sourceA : sourceB;
    if (!dataset) return;
    try {
      await apiDelete(`/uploads/${dataset.upload_id}`);
      if (side === 'a') setSourceA(null); else setSourceB(null);
      setKeyPairs([{ left: '', right: '' }]);
      setComparePairs([]);
      setActiveRun(null);
      showNotice('success', `Removed the saved copy of ${dataset.filename}. Your original file on disk was not changed; historical run results remain available.`);
    } catch (error) {
      showNotice('error', error.message);
    }
  };

  const addKey = () => {
    if (keyPairs.length >= 5 || !sourceA || !sourceB) return;
    const availableA = sourceA.columns.map((c) => c.name).find((c) => !keyPairs.some((p) => p.left === c)) || '';
    const availableB = sourceB.columns.map((c) => c.name).find((c) => !keyPairs.some((p) => p.right === c)) || '';
    setKeyPairs((old) => [...old, { left: availableA, right: availableB }]);
  };

  const removeKey = (index) => {
    if (keyPairs.length === 1) return;
    setKeyPairs((old) => old.filter((_, i) => i !== index));
  };

  const selectedKeyColumns = useMemo(() => ({
    left: new Set(keyPairs.map((p) => p.left).filter(Boolean)),
    right: new Set(keyPairs.map((p) => p.right).filter(Boolean)),
  }), [keyPairs]);

  const commonCompareOptions = useMemo(() => {
    if (!sourceA || !sourceB) return [];
    const rightColumns = new Set(sourceB.columns.map((c) => c.name));
    return sourceA.columns.map((c) => c.name).filter((name) => rightColumns.has(name))
      .map((name) => ({ left: name, right: name }))
      .filter((pair) => !selectedKeyColumns.left.has(pair.left) && !selectedKeyColumns.right.has(pair.right));
  }, [sourceA, sourceB, selectedKeyColumns]);

  const usableComparePairs = useMemo(() => comparePairs.filter((pair) => pair.left && pair.right &&
    !selectedKeyColumns.left.has(pair.left) && !selectedKeyColumns.right.has(pair.right)), [comparePairs, selectedKeyColumns]);

  const customCompareEntries = useMemo(() => comparePairs.map((pair, index) => ({ pair, index }))
    .filter(({ pair }) => !commonCompareOptions.some((option) => pairId(option) === pairId(pair)))
    .filter(({ pair }) => (!pair.left || !selectedKeyColumns.left.has(pair.left)) && (!pair.right || !selectedKeyColumns.right.has(pair.right))),
  [comparePairs, commonCompareOptions, selectedKeyColumns]);

  const addCustomMapping = () => setComparePairs((old) => [...old, { left: '', right: '' }]);
  const updateCustomMapping = (index, side, value) => setComparePairs((old) => {
    const next = old.map((pair, i) => i === index ? { ...pair, [side]: value } : pair);
    const seen = new Set();
    return next.filter((pair) => {
      if (!pair.left || !pair.right) return true;
      const id = pairId(pair);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  });
  const removeCustomMapping = (index) => setComparePairs((old) => old.filter((_, i) => i !== index));

  const runReconciliation = async () => {
    if (!sourceA || !sourceB) return showNotice('error', 'Upload both datasets before running a reconciliation.');
    if (keyPairs.some((pair) => !pair.left || !pair.right)) return showNotice('error', 'Choose a matching column on both sides for every key row.');
    if (new Set(keyPairs.map((pair) => pair.left)).size !== keyPairs.length || new Set(keyPairs.map((pair) => pair.right)).size !== keyPairs.length) {
      return showNotice('error', 'Each matching column can only be used once in the composite key.');
    }
    clearNotice();
    setIsWorking(true);
    setWorkingMessage('Checking keys, data quality, and row-level differences…');
    try {
      const result = await apiPost('/reconciliations', {
        source_a_upload_id: sourceA.upload_id,
        source_b_upload_id: sourceB.upload_id,
        key_pairs: keyPairs,
        compare_pairs: usableComparePairs,
        trim_whitespace: trimWhitespace,
        case_insensitive: caseInsensitive,
        numeric_tolerance: Number(numericTolerance || 0),
        fuzzy_enabled: fuzzyEnabled,
        fuzzy_threshold: fuzzyThreshold,
      });
      setActiveRun(result);
      setExceptionResult(result.exceptions);
      setFilterType('all');
      setSearchText('');
      setAppliedSearch('');
      setView('workspace');
      setShowProfileInput(false);
      showNotice('success', 'Reconciliation complete. Review the exceptions below and export the report when ready.');
    } catch (error) {
      showNotice('error', error.message);
    } finally {
      setIsWorking(false);
      setWorkingMessage('');
    }
  };

  const refreshExceptions = useCallback(async (runId, page = 1, selectedFilter = filterType, search = appliedSearch) => {
    try {
      const params = new URLSearchParams({ page: String(page), page_size: '30', exception_type: selectedFilter || 'all' });
      if (search.trim()) params.set('search', search.trim());
      const data = await apiGet(`/runs/${runId}?${params.toString()}`);
      setActiveRun(data);
      setExceptionResult(data.exceptions);
    } catch (error) {
      showNotice('error', error.message);
    }
  }, [filterType, appliedSearch]);

  const openRun = async (runId) => {
    try {
      const data = await apiGet(`/runs/${runId}`);
      setActiveRun(data);
      setExceptionResult(data.exceptions);
      setFilterType('all');
      setSearchText('');
      setAppliedSearch('');
      setView('workspace');
      showNotice('success', `Opened saved run “${data.name}”.`);
    } catch (error) {
      showNotice('error', error.message);
    }
  };

  const refreshHistory = useCallback(async () => {
    try {
      const [runData, auditData] = await Promise.all([apiGet('/runs'), apiGet('/audit?limit=100')]);
      setHistory(runData.items);
      setAudit(auditData.items);
    } catch (error) {
      showNotice('error', error.message);
    }
  }, []);

  const refreshProfiles = useCallback(async () => {
    try {
      const data = await apiGet('/profiles');
      setProfiles(data.items);
    } catch (error) {
      showNotice('error', error.message);
    }
  }, []);

  useEffect(() => {
    if (view === 'history') refreshHistory();
    if (view === 'profiles') refreshProfiles();
  }, [view, refreshHistory, refreshProfiles]);

  const saveProfile = async () => {
    if (!profileName.trim()) return showNotice('error', 'Enter a name for this rule profile.');
    if (keyPairs.some((pair) => !pair.left || !pair.right)) return showNotice('error', 'Complete the matching keys before saving a profile.');
    try {
      await apiPost('/profiles', { name: profileName.trim(), config: {
        key_pairs: keyPairs, compare_pairs: usableComparePairs, trim_whitespace: trimWhitespace,
        case_insensitive: caseInsensitive, numeric_tolerance: Number(numericTolerance || 0),
        fuzzy_enabled: fuzzyEnabled, fuzzy_threshold: fuzzyThreshold,
      }});
      setProfileName('');
      setShowProfileInput(false);
      showNotice('success', 'Rule profile saved for reuse.');
      refreshProfiles();
    } catch (error) {
      showNotice('error', error.message);
    }
  };

  const applyProfile = (profile) => {
    const config = profile.config;
    setKeyPairs(config.key_pairs || [{ left: '', right: '' }]);
    setComparePairs(config.compare_pairs || []);
    setTrimWhitespace(config.trim_whitespace ?? true);
    setCaseInsensitive(config.case_insensitive ?? false);
    setNumericTolerance(String(config.numeric_tolerance ?? 0));
    setFuzzyEnabled(config.fuzzy_enabled ?? false);
    setFuzzyThreshold(config.fuzzy_threshold ?? 0.85);
    setView('workspace');
    showNotice('success', `Applied profile “${profile.name}”. Confirm its fields against the uploaded datasets before running.`);
  };

  const deleteProfile = async (profile) => {
    try {
      await apiDelete(`/profiles/${profile.id}`);
      setProfiles((old) => old.filter((item) => item.id !== profile.id));
      showNotice('success', `Deleted profile “${profile.name}”.`);
    } catch (error) {
      showNotice('error', error.message);
    }
  };

  const doExport = async (format) => {
    if (!activeRun) return;
    try {
      await downloadExport(activeRun.id, format);
      showNotice('success', `${format.toUpperCase()} report download started.`);
    } catch (error) {
      showNotice('error', error.message);
    }
  };

  const exceptionTypes = useMemo(() => {
    const counts = activeRun?.summary?.exception_counts || {};
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [activeRun]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><GitCompare size={21} strokeWidth={2.2} /></div>
          <div><div className="brand-name">reconcile</div><div className="brand-caption">DATA WORKBENCH</div></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <button className={`nav-item ${view === 'workspace' ? 'active' : ''}`} onClick={() => setView('workspace')}>
            <LayoutDashboard size={17} /><span>Reconciliation</span><span className="nav-shortcut">01</span>
          </button>
          <button className={`nav-item ${view === 'profiles' ? 'active' : ''}`} onClick={() => setView('profiles')}>
            <BookOpen size={17} /><span>Rule profiles</span>
            {profiles.length > 0 && <span className="nav-count">{profiles.length}</span>}
          </button>
          <button className={`nav-item ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}>
            <History size={17} /><span>Run history</span>
          </button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="local-card">
          <div className="local-icon"><ShieldCheck size={17} /></div>
          <div><strong>Local by default</strong><p>Files are processed on this machine. No external AI service is used.</p></div>
        </div>
        <div className="sidebar-footer"><span className="status-dot" /> Workbench v0.1.0 <span className="footer-sep">·</span> MVP</div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{view === 'workspace' ? 'Reconciliation' : view === 'profiles' ? 'Rule profiles' : 'Run history'}</strong></div>
          <div className="topbar-right"><span className="local-pill"><span className="status-dot" /> Local processing</span><div className="avatar">DQ</div></div>
        </header>

        {notice && <div className={`notice notice-${notice.type}`} role="status">
          {notice.type === 'error' ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
          <span>{notice.message}</span><button aria-label="Dismiss notification" onClick={clearNotice}><X size={16} /></button>
        </div>}

        {view === 'workspace' && (
          <div className="page-content">
            <div className="page-heading">
              <div><div className="eyebrow"><span className="eyebrow-line" /> DATA QUALITY / RECONCILIATION</div>
                <h1>Reconcile two datasets.</h1>
                <p className="page-subtitle">Find what changed, what’s missing, and what needs a human review — with a clear reason for every exception.</p>
              </div>
              <button className="button button-ghost" onClick={handleDemo} disabled={isWorking}><Sparkles size={16} /> Load demo data</button>
            </div>

            <section className="section-block">
              <div className="section-heading"><div className="section-number">01</div><div><h2>Choose your files</h2><p>Upload a baseline and the file you want to check against it.</p></div><span className="section-meta">CSV · XLSX · XLSM / 50 MB max</span></div>
              <div className="upload-grid">
                <UploadPanel side="a" dataset={sourceA} inputRef={inputA} isWorking={isWorking} onSelect={(file) => handleUpload('a', file)} onSheetChange={(sheet) => handleSheetChange('a', sheet)} onRemove={() => removeDataset('a')} />
                <div className="upload-connector"><div><ArrowLeftRight size={17} /></div><span>COMPARE</span></div>
                <UploadPanel side="b" dataset={sourceB} inputRef={inputB} isWorking={isWorking} onSelect={(file) => handleUpload('b', file)} onSheetChange={(sheet) => handleSheetChange('b', sheet)} onRemove={() => removeDataset('b')} />
              </div>
            </section>

            <section className="section-block rules-section">
              <div className="section-heading"><div className="section-number">02</div><div><h2>Define matching rules</h2><p>Tell the workbench how to identify the same record across files.</p></div></div>
              {!sourceA || !sourceB ? <div className="rules-empty"><div className="empty-icon"><Settings2 size={20} /></div><div><strong>Waiting for both datasets</strong><p>Upload two files or load the demo data to configure keys and comparison fields.</p></div></div> : <>
                <div className="key-card">
                  <div className="card-topline"><div><strong>Matching keys</strong><p>Rows are paired only when every selected key matches. Composite keys are supported.</p></div><button className="button button-small button-ghost" onClick={addKey} disabled={keyPairs.length >= 5}><Plus size={15} /> Add key</button></div>
                  <div className="key-table-header"><span>DATASET A COLUMN</span><span className="key-arrow-header"><ArrowLeftRight size={13} /></span><span>DATASET B COLUMN</span><span /></div>
                  <div className="key-rows">{keyPairs.map((pair, index) => <div className="key-row" key={`key-${index}`}>
                    <select aria-label={`Source A matching key ${index + 1}`} value={pair.left} onChange={(event) => keyChange(index, 'left', event.target.value)}>
                      <option value="">Select a column…</option>{sourceA.columns.map((col) => <option key={col.name} value={col.name}>{col.name}</option>)}
                    </select>
                    <div className="key-arrow"><ArrowLeftRight size={15} /></div>
                    <select aria-label={`Source B matching key ${index + 1}`} value={pair.right} onChange={(event) => keyChange(index, 'right', event.target.value)}>
                      <option value="">Select a column…</option>{sourceB.columns.map((col) => <option key={col.name} value={col.name}>{col.name}</option>)}
                    </select>
                    <button className="icon-button remove-key" aria-label="Remove matching key" onClick={() => removeKey(index)} disabled={keyPairs.length === 1}><X size={15} /></button>
                  </div>)}</div>
                  <div className="rule-footnote"><CheckCircle2 size={14} /><span>Duplicate keys are flagged and excluded from automatic pairing.</span></div>
                </div>

                <div className="key-card compare-card">
                  <div className="card-topline"><div><strong>Fields to compare</strong><p>Exact-name columns are suggested automatically. You can also map differently named fields.</p></div><div className="compare-heading-actions"><button className="text-button" onClick={addCustomMapping}><Plus size={13} /> Map fields</button><button className="text-button" onClick={() => setComparePairs(commonCompareOptions)}>Select all</button></div></div>
                  {commonCompareOptions.length ? <div className="compare-options">{commonCompareOptions.map((pair) => <label className="compare-option" key={pairId(pair)}>
                    <input type="checkbox" checked={usableComparePairs.some((p) => pairId(p) === pairId(pair))} onChange={(event) => setComparePairs((old) => event.target.checked ? [...old.filter((p) => pairId(p) !== pairId(pair)), pair] : old.filter((p) => pairId(p) !== pairId(pair)))} />
                    <span className="checkmark"><Check size={12} /></span><span className="compare-name">{pair.left}</span><span className="compare-pair-arrow"><ArrowLeftRight size={13} /></span><span className="compare-name">{pair.right}</span>
                  </label>)}</div> : <div className="inline-empty">No common non-key column names found. Add a field mapping to compare differently named columns.</div>}
                  {customCompareEntries.length > 0 && <div className="custom-mappings"><div className="custom-mapping-heading">CUSTOM FIELD MAPPINGS <span>Source A ↔ Source B</span></div>{customCompareEntries.map(({ pair, index }) => <div className="custom-mapping-row" key={`custom-${index}`}>
                    <select aria-label={`Custom comparison Source A field ${index + 1}`} value={pair.left} onChange={(event) => updateCustomMapping(index, 'left', event.target.value)}><option value="">Select a field…</option>{sourceA.columns.filter((col) => !selectedKeyColumns.left.has(col.name)).map((col) => <option key={col.name} value={col.name}>{col.name}</option>)}</select>
                    <div><ArrowLeftRight size={14} /></div>
                    <select aria-label={`Custom comparison Source B field ${index + 1}`} value={pair.right} onChange={(event) => updateCustomMapping(index, 'right', event.target.value)}><option value="">Select a field…</option>{sourceB.columns.filter((col) => !selectedKeyColumns.right.has(col.name)).map((col) => <option key={col.name} value={col.name}>{col.name}</option>)}</select>
                    <button className="icon-button" aria-label="Remove custom field mapping" onClick={() => removeCustomMapping(index)}><X size={15} /></button>
                  </div>)}</div>}
                  <div className="compare-footer"><span>{usableComparePairs.length} field{usableComparePairs.length === 1 ? '' : 's'} selected</span><span>Values are compared without changing source files.</span></div>
                </div>

                <div className="options-card">
                  <div className="options-title"><Settings2 size={17} /><strong>Matching options</strong><span>OPTIONAL</span></div>
                  <div className="option-list">
                    <ToggleOption checked={trimWhitespace} onChange={setTrimWhitespace} title="Trim surrounding whitespace" detail="Treat “ ACC-12 ” and “ACC-12” as the same key or value." />
                    <ToggleOption checked={caseInsensitive} onChange={setCaseInsensitive} title="Ignore letter case" detail="Treat “ACTIVE” and “Active” as equal during key and value comparison." />
                    <div className="option-row tolerance-row"><div><strong>Numeric tolerance</strong><p>Allow a small numeric difference before flagging a mismatch.</p></div><div className="tolerance-input-wrap"><input aria-label="Numeric tolerance" type="number" min="0" step="0.01" value={numericTolerance} onChange={(e) => setNumericTolerance(e.target.value)} /><span>absolute</span></div></div>
                    <div className="option-row fuzzy-row"><div><div className="option-title-inline"><strong>Suggest fuzzy matches</strong><span className="advanced-tag">ADVANCED</span></div><p>Suggest close key values for manual review. Never auto-merges records.</p></div><div className="fuzzy-controls"><label className="switch"><input type="checkbox" checked={fuzzyEnabled} onChange={(e) => setFuzzyEnabled(e.target.checked)} /><span className="switch-track" /></label>{fuzzyEnabled && <label className="threshold"><span>{Math.round(fuzzyThreshold * 100)}% confidence</span><input aria-label="Fuzzy confidence threshold" type="range" min="0.6" max="1" step="0.05" value={fuzzyThreshold} onChange={(e) => setFuzzyThreshold(Number(e.target.value))} /></label>}</div></div>
                  </div>
                </div>

                <div className="run-actions"><div className="run-assurance"><ShieldCheck size={16} /><span>Read-only comparison · Originals stay untouched</span></div><button className="button button-primary button-run" onClick={runReconciliation} disabled={isWorking || !keyPairs.every((pair) => pair.left && pair.right)}>{isWorking ? <Loader2 className="spin" size={17} /> : <GitCompare size={17} />}{isWorking ? (workingMessage || 'Working…') : 'Run reconciliation'}<span className="button-arrow">→</span></button></div>
              </>}
            </section>

            {activeRun && <ResultsPanel run={activeRun} exceptionResult={exceptionResult} filterType={filterType} setFilterType={(type) => { setFilterType(type); refreshExceptions(activeRun.id, 1, type, appliedSearch); }} searchText={searchText} setSearchText={setSearchText} applySearch={() => { setAppliedSearch(searchText); refreshExceptions(activeRun.id, 1, filterType, searchText); }} clearSearch={() => { setSearchText(''); setAppliedSearch(''); refreshExceptions(activeRun.id, 1, filterType, ''); }} onPage={(page) => refreshExceptions(activeRun.id, page, filterType, appliedSearch)} onExport={doExport} onSaveProfile={() => setShowProfileInput(true)} showProfileInput={showProfileInput} profileName={profileName} setProfileName={setProfileName} saveProfile={saveProfile} cancelProfile={() => { setShowProfileInput(false); setProfileName(''); }} />}
            <footer className="page-footer"><span>RECONCILE <span className="footer-dot">·</span> DATA QUALITY WORKBENCH</span><span><HardDrive size={13} /> Designed for repeatable, explainable file checks</span></footer>
          </div>
        )}

        {view === 'profiles' && <ProfilesView profiles={profiles} onApply={applyProfile} onDelete={deleteProfile} onRefresh={refreshProfiles} />}
        {view === 'history' && <HistoryView history={history} audit={audit} tab={historyTab} setTab={setHistoryTab} onOpenRun={openRun} onRefresh={refreshHistory} />}
      </main>
    </div>
  );
}

function UploadPanel({ side, dataset, inputRef, isWorking, onSelect, onSheetChange, onRemove }) {
  const [dragOver, setDragOver] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const isA = side === 'a';
  return <div className={`upload-panel ${dragOver ? 'drag-over' : ''} ${dataset ? 'has-file' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); onSelect(event.dataTransfer.files?.[0]); }}>
    <div className="upload-panel-heading"><div className={`source-icon ${isA ? 'source-icon-a' : 'source-icon-b'}`}><FileSpreadsheet size={19} /></div><div><div className="source-label">SOURCE {isA ? 'A' : 'B'} <span>{isA ? 'BASELINE' : 'TO RECONCILE'}</span></div><h3>{isA ? 'Reference dataset' : 'Comparison dataset'}</h3></div>{dataset && <span className="ready-label"><span className="status-dot" /> READY</span>}</div>
    {!dataset ? <button type="button" className="dropzone" onClick={() => inputRef.current?.click()} disabled={isWorking}>
      <div className="dropzone-icon"><Upload size={20} /></div><strong>Choose a file <span>or drop it here</span></strong><small>CSV or Excel workbook</small>
    </button> : <div className="file-details">
      <div className="file-details-top"><div className="file-mini-icon"><FileSpreadsheet size={19} /></div><div className="file-name-wrap"><strong title={dataset.filename}>{dataset.filename}</strong><span>{formatBytes(dataset.size_bytes)} <span className="tiny-dot">·</span> {dataset.extension.replace('.', '').toUpperCase()}</span></div><button className="icon-button" aria-label="Replace dataset" title="Replace dataset" onClick={() => inputRef.current?.click()} disabled={isWorking}><Upload size={15} /></button><button className="icon-button remove-upload" aria-label="Remove saved dataset" title="Remove saved copy" onClick={onRemove} disabled={isWorking}><X size={15} /></button></div>
      <div className="dataset-stats"><div><strong>{formatNumber(dataset.row_count)}</strong><span>ROWS</span></div><div><strong>{dataset.column_count}</strong><span>COLUMNS</span></div><div><strong>{formatNumber(dataset.missing_cells)}</strong><span>MISSING CELLS</span></div></div>
      {dataset.sheet_names?.length > 1 && <label className="sheet-select-label">WORKSHEET<select value={dataset.selected_sheet || dataset.sheet_names[0]} onChange={(e) => onSheetChange(e.target.value)}>{dataset.sheet_names.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}</select><ChevronDown className="select-chevron" size={14} /></label>}
      <div className="column-chips">{dataset.columns.slice(0, 4).map((col) => <span key={col.name} title={`${col.name} · ${col.inferred_type}`}>{col.name}</span>)}{dataset.columns.length > 4 && <span className="more-chips">+{dataset.columns.length - 4}</span>}</div>
      <button className="text-button preview-toggle" onClick={() => setShowPreview((old) => !old)}>{showPreview ? 'Hide sample rows' : 'Preview sample rows'} <ChevronDown size={13} className={showPreview ? 'rotate-chevron' : ''} /></button>
      {showPreview && <div className="sample-preview-wrap"><table className="sample-preview"><thead><tr>{dataset.columns.slice(0, 5).map((col) => <th key={col.name}>{col.name}</th>)}{dataset.columns.length > 5 && <th>…</th>}</tr></thead><tbody>{(dataset.preview || []).map((row, i) => <tr key={i}>{dataset.columns.slice(0, 5).map((col) => <td key={col.name} title={row[col.name] == null ? '' : String(row[col.name])}>{row[col.name] == null || row[col.name] === '' ? '—' : String(row[col.name])}</td>)}{dataset.columns.length > 5 && <td>…</td>}</tr>)}</tbody></table></div>}
    </div>}
    <input ref={inputRef} className="file-input" type="file" accept=".csv,.xlsx,.xlsm" onChange={(event) => { onSelect(event.target.files?.[0]); event.target.value = ''; }} />
  </div>;
}

function ToggleOption({ checked, onChange, title, detail }) {
  return <div className="option-row"><div><strong>{title}</strong><p>{detail}</p></div><label className="switch"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="switch-track" /></label></div>;
}

function ResultsPanel({ run, exceptionResult, filterType, setFilterType, searchText, setSearchText, applySearch, clearSearch, onPage, onExport, onSaveProfile, showProfileInput, profileName, setProfileName, saveProfile, cancelProfile }) {
  const summary = run.summary || {};
  const [showTypeFilter, setShowTypeFilter] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [selectedTab, setSelectedTab] = useState('exceptions');
  const [overviewOpen, setOverviewOpen] = useState(false);
  const filterOptions = Object.keys(summary.exception_counts || {}).sort((a, b) => (summary.exception_counts[b] || 0) - (summary.exception_counts[a] || 0));
  return <section className="results-section" id="results">
    <div className="results-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> RECONCILIATION RESULTS</div><h2>{run.name}</h2><p className="results-subtitle">Completed {displayDate(run.created_at)} <span className="tiny-dot">·</span> {run.source_a_name} <ArrowLeftRight size={13} /> {run.source_b_name}</p></div><div className="result-actions"><button className="button button-ghost" onClick={onSaveProfile}><Save size={15} /> Save rules</button><div className="export-menu-wrap"><button className="button button-primary" onClick={() => setExportMenu((old) => !old)}><Download size={16} /> Export report <ChevronDown size={14} /></button>{exportMenu && <div className="export-dropdown"><button onClick={() => { onExport('xlsx'); setExportMenu(false); }}><FileSpreadsheet size={16} /><span><strong>Excel workbook</strong><small>Summary and exception details</small></span></button><button onClick={() => { onExport('csv'); setExportMenu(false); }}><FileSpreadsheet size={16} /><span><strong>CSV exceptions</strong><small>Flat exception list</small></span></button></div>}</div></div></div>
    {showProfileInput && <div className="save-profile-strip"><div><Save size={17} /><div><strong>Save this rule set</strong><small>Reuse matching keys, compare fields, and normalization options.</small></div></div><input value={profileName} maxLength={100} onChange={(e) => setProfileName(e.target.value)} placeholder="e.g. Monthly account reconciliation" onKeyDown={(e) => e.key === 'Enter' && saveProfile()} /><button className="button button-primary button-small" onClick={saveProfile}>Save profile</button><button className="icon-button" onClick={cancelProfile} aria-label="Cancel saving profile"><X size={16} /></button></div>}
    <div className="summary-grid">
      <SummaryCard label="Matched records" value={summary.matched_records} sub={`${formatNumber(summary.matched_without_differences)} with no value differences`} icon={<CheckCircle2 size={17} />} tone="green" />
      <SummaryCard label="Value mismatches" value={summary.value_mismatches} sub={`${formatNumber(summary.matched_with_differences)} matched records affected`} icon={<GitCompare size={17} />} tone="amber" />
      <SummaryCard label="Only in A / B" value={`${formatNumber(summary.records_only_in_a)} / ${formatNumber(summary.records_only_in_b)}`} sub="Records missing from the other file" icon={<ArrowLeftRight size={17} />} tone="blue" />
      <SummaryCard label="Exceptions" value={summary.exception_count} sub={`${formatNumber(summary.missing_values_a + summary.missing_values_b)} missing cells`} icon={<AlertCircle size={17} />} tone="red" />
    </div>
    <div className="quality-strip"><div className="quality-strip-main"><div className="quality-strip-icon"><Activity size={17} /></div><div><strong>Data quality signals</strong><p>Duplicate keys are held for review. Fuzzy suggestions remain advisory and do not change exact match results.</p></div></div><div className="quality-mini-stats"><div><span>Duplicate keys</span><strong>{formatNumber(summary.duplicate_key_rows_a + summary.duplicate_key_rows_b)}</strong></div><div><span>Duplicate rows</span><strong>{formatNumber(summary.duplicate_full_rows_a + summary.duplicate_full_rows_b)}</strong></div><div><span>Fuzzy suggestions</span><strong>{formatNumber(summary.fuzzy_suggestions)}</strong></div></div><button className="icon-button quality-expand" onClick={() => setOverviewOpen((old) => !old)} aria-label={overviewOpen ? 'Collapse data quality details' : 'Expand data quality details'}>{overviewOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button></div>
    {overviewOpen && <div className="quality-details"><div><span>Source A</span><strong>{formatNumber(summary.source_a_rows)} rows</strong><small>{formatNumber(summary.missing_values_a)} missing values · {formatNumber(summary.duplicate_key_rows_a)} duplicate-key rows · {formatNumber(summary.duplicate_full_rows_a)} duplicated rows</small></div><div><span>Source B</span><strong>{formatNumber(summary.source_b_rows)} rows</strong><small>{formatNumber(summary.missing_values_b)} missing values · {formatNumber(summary.duplicate_key_rows_b)} duplicate-key rows · {formatNumber(summary.duplicate_full_rows_b)} duplicated rows</small></div></div>}
    {run.warnings?.length > 0 && <div className="warning-list">{run.warnings.map((warning, i) => <div key={i}><AlertCircle size={15} />{warning}</div>)}</div>}
    <div className="exceptions-card">
      <div className="exceptions-header"><div><h3>Exception register</h3><p>A traceable list of records that need attention.</p></div><div className="exception-header-count"><span className="status-dot status-dot-warn" /> {formatNumber(exceptionResult.total)} {filterType === 'all' ? 'items' : 'filtered items'}</div></div>
      <div className="results-tabs"><button className={selectedTab === 'exceptions' ? 'selected' : ''} onClick={() => setSelectedTab('exceptions')}>Exceptions <span>{formatNumber(summary.exception_count)}</span></button><button className={selectedTab === 'rules' ? 'selected' : ''} onClick={() => setSelectedTab('rules')}>Applied rules</button></div>
      {selectedTab === 'exceptions' ? <>
        <div className="table-toolbar"><div className="search-input-wrap"><Search size={15} /><input aria-label="Search exceptions" value={searchText} onChange={(e) => setSearchText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applySearch()} placeholder="Search key, field, or explanation" /><button onClick={clearSearch} title="Clear search" aria-label="Clear search"><X size={14} /></button></div><div className="filter-wrap"><button className={`button button-small ${filterType !== 'all' ? 'button-filter-active' : 'button-ghost'}`} onClick={() => setShowTypeFilter((old) => !old)}><Filter size={14} /> Filter type <ChevronDown size={13} /></button>{showTypeFilter && <div className="filter-dropdown"><button className={filterType === 'all' ? 'filter-selected' : ''} onClick={() => { setFilterType('all'); setShowTypeFilter(false); }}>All exceptions <span>{formatNumber(summary.exception_count)}</span></button>{filterOptions.map((type) => <button key={type} className={filterType === type ? 'filter-selected' : ''} onClick={() => { setFilterType(type); setShowTypeFilter(false); }}><span>{humanize(type)}</span><span>{formatNumber(summary.exception_counts[type])}</span></button>)}</div>}</div></div>
        <div className="table-scroll"><table className="exception-table"><thead><tr><th>EXCEPTION</th><th>RECORD KEY</th><th>FIELD</th><th>SOURCE A VALUE</th><th>SOURCE B VALUE</th><th>DETAIL</th></tr></thead><tbody>
          {exceptionResult.items.map((item, index) => <tr key={`${item.exception_type}-${item.source_a_row}-${item.source_b_row}-${item.column}-${index}`}>
            <td><span className={`severity-chip severity-${item.severity || 'warning'}`}>{item.severity === 'error' ? <AlertCircle size={12} /> : item.severity === 'info' ? <Sparkles size={12} /> : <Activity size={12} />}{humanize(item.exception_type)}</span></td>
            <td><span className="key-value" title={item.key || 'No usable key'}>{item.key || '—'}</span><small className="row-reference">{item.source_a_row ? `A · row ${item.source_a_row}` : ''}{item.source_a_row && item.source_b_row ? ' / ' : ''}{item.source_b_row ? `B · row ${item.source_b_row}` : ''}</small></td>
            <td className="field-value">{item.column || '—'}{item.confidence != null && <small>{Math.round(item.confidence * 100)}% confidence</small>}</td>
            <td><ValueCell value={item.source_a_value} /></td><td><ValueCell value={item.source_b_value} /></td><td className="detail-cell">{item.message}{item.confidence != null && <small>Suggestion only — verify before accepting.</small>}</td>
          </tr>)}
          {exceptionResult.items.length === 0 && <tr><td colSpan="6"><div className="table-empty"><CheckCircle2 size={21} /><strong>No exceptions in this view</strong><span>Try another filter or clear your search.</span></div></td></tr>}
        </tbody></table></div>
        <div className="table-footer"><span>Showing {exceptionResult.items.length ? ((exceptionResult.page - 1) * exceptionResult.page_size + 1) : 0}–{Math.min(exceptionResult.page * exceptionResult.page_size, exceptionResult.total)} of {formatNumber(exceptionResult.total)}</span><div className="pagination"><button className="icon-button" onClick={() => onPage(Math.max(1, exceptionResult.page - 1))} disabled={exceptionResult.page <= 1} aria-label="Previous page"><ChevronLeft size={16} /></button><span>Page <strong>{exceptionResult.page || 1}</strong> of <strong>{exceptionResult.pages || 1}</strong></span><button className="icon-button" onClick={() => onPage(Math.min(exceptionResult.pages, exceptionResult.page + 1))} disabled={!exceptionResult.pages || exceptionResult.page >= exceptionResult.pages} aria-label="Next page"><ChevronRight size={16} /></button></div></div>
      </> : <div className="applied-rules-view"><div><span>Matching keys</span><div>{(run.config?.key_pairs || []).map((pair, i) => <span key={i} className="rule-pill">{pair.left} <ArrowLeftRight size={12} /> {pair.right}</span>)}</div></div><div><span>Compared fields</span><div>{(run.config?.compare_pairs || []).length ? run.config.compare_pairs.map((pair, i) => <span key={i} className="rule-pill">{pair.left} <ArrowLeftRight size={12} /> {pair.right}</span>) : <small>No non-key value fields selected.</small>}</div></div><div><span>Normalization & tolerance</span><p>{run.config?.trim_whitespace ? 'Trim whitespace' : 'Preserve whitespace'} <span>·</span> {run.config?.case_insensitive ? 'Case-insensitive' : 'Case-sensitive'} <span>·</span> Numeric tolerance {run.config?.numeric_tolerance ?? 0}</p></div><div><span>Fuzzy matching</span><p>{run.config?.fuzzy_enabled ? `Enabled · ${Math.round((run.config?.fuzzy_threshold ?? 0.85) * 100)}% threshold · suggestions only` : 'Disabled'}</p></div></div>}
    </div>
  </section>;
}

function SummaryCard({ label, value, sub, icon, tone }) {
  return <div className={`summary-card summary-${tone}`}><div className="summary-card-head"><span>{label}</span><div className="summary-icon">{icon}</div></div><strong className="summary-value">{typeof value === 'number' ? formatNumber(value) : value ?? '—'}</strong><span className="summary-caption">{sub}</span></div>;
}

function ValueCell({ value }) {
  if (value === null || value === undefined || value === '') return <span className="empty-value">(blank)</span>;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return <span className="table-value" title={text}>{text}</span>;
}

function ProfilesView({ profiles, onApply, onDelete, onRefresh }) {
  return <div className="page-content inner-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> REUSABLE CONFIGURATION</div><h1>Rule profiles.</h1><p className="page-subtitle">Keep recurring checks consistent. Save your matching keys, compared fields, and normalization preferences once.</p></div><button className="button button-ghost" onClick={onRefresh}><RefreshCw size={15} /> Refresh</button></div>
    <div className="profile-callout"><div className="profile-callout-icon"><BookOpen size={20} /></div><div><strong>Profiles store rules, not uploaded files.</strong><p>Apply a profile after uploading datasets with compatible column names. Always review the selected fields before running.</p></div></div>
    {profiles.length ? <div className="profile-grid">{profiles.map((profile) => <div className="profile-card" key={profile.id}><div className="profile-card-icon"><Settings2 size={18} /></div><div className="profile-card-date">UPDATED {displayDate(profile.updated_at).toUpperCase()}</div><h3>{profile.name}</h3><p>{(profile.config.key_pairs || []).map((pair) => `${pair.left} ↔ ${pair.right}`).join(' + ') || 'No key configured'}</p><div className="profile-card-meta"><span>{(profile.config.key_pairs || []).length} matching key(s)</span><span>{(profile.config.compare_pairs || []).length} compared fields</span></div><div className="profile-card-actions"><button className="button button-primary button-small" onClick={() => onApply(profile)}>Apply profile <span>→</span></button><button className="icon-button" aria-label={`Delete ${profile.name}`} onClick={() => onDelete(profile)}><Trash2 size={15} /></button></div></div>)}</div> : <div className="page-empty"><div className="page-empty-icon"><BookOpen size={23} /></div><h3>No saved profiles yet</h3><p>Run a reconciliation and use <strong>Save rules</strong> in the results section to keep a reusable configuration.</p><button className="button button-ghost" onClick={onRefresh}><RefreshCw size={15} /> Check again</button></div>}
    <footer className="page-footer"><span>RECONCILE <span className="footer-dot">·</span> RULE PROFILES</span><span>Profiles are stored in the local SQLite database.</span></footer>
  </div>;
}

function HistoryView({ history, audit, tab, setTab, onOpenRun, onRefresh }) {
  return <div className="page-content inner-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> ACTIVITY & TRACEABILITY</div><h1>Run history.</h1><p className="page-subtitle">Reopen a prior comparison or inspect the workbench’s audit trail.</p></div><button className="button button-ghost" onClick={onRefresh}><RefreshCw size={15} /> Refresh</button></div>
    <div className="history-tabs"><button className={tab === 'runs' ? 'selected' : ''} onClick={() => setTab('runs')}><History size={15} /> Reconciliation runs <span>{history.length}</span></button><button className={tab === 'audit' ? 'selected' : ''} onClick={() => setTab('audit')}><ShieldCheck size={15} /> Audit log</button></div>
    {tab === 'runs' ? <div className="history-table-card"><div className="history-table-heading"><div><h3>Recent runs</h3><p>Latest first · Select a run to reopen its exception register.</p></div><span className="subtle-count">{history.length} recorded</span></div><div className="table-scroll"><table className="history-table"><thead><tr><th>RUN</th><th>CREATED</th><th>SOURCE A</th><th>SOURCE B</th><th>MATCHED</th><th>EXCEPTIONS</th><th></th></tr></thead><tbody>{history.map((run) => <tr key={run.id}><td><strong className="history-run-name">{run.name}</strong><small className="history-run-id">{run.id.slice(0, 8)}</small></td><td>{displayDate(run.created_at)}</td><td>{run.source_a_name}</td><td>{run.source_b_name}</td><td><span className="match-count"><CheckCircle2 size={14} /> {formatNumber(run.summary.matched_records)}</span></td><td><span className="exception-count-pill">{formatNumber(run.summary.exception_count)}</span></td><td><button className="button button-small button-ghost" onClick={() => onOpenRun(run.id)}>Open <span>→</span></button></td></tr>)}{!history.length && <tr><td colSpan="7"><div className="table-empty"><History size={22} /><strong>No runs yet</strong><span>Complete your first reconciliation and it will show up here.</span></div></td></tr>}</tbody></table></div></div> : <div className="history-table-card"><div className="history-table-heading"><div><h3>Audit events</h3><p>Operational metadata only; cell contents are not written to the audit log.</p></div><span className="subtle-count">Latest {audit.length}</span></div><div className="table-scroll"><table className="history-table audit-table"><thead><tr><th>EVENT</th><th>TIME (UTC)</th><th>ENTITY</th><th>DETAILS</th></tr></thead><tbody>{audit.map((event) => <tr key={event.id}><td><span className="audit-action"><span className="audit-dot" />{event.action}</span></td><td>{displayDate(event.created_at)}</td><td>{event.entity_type}{event.entity_id ? <small className="history-run-id">{event.entity_id.slice(0, 12)}</small> : null}</td><td className="audit-detail">{Object.entries(event.details || {}).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(' · ') || '—'}</td></tr>)}{!audit.length && <tr><td colSpan="4"><div className="table-empty"><ShieldCheck size={22} /><strong>No audit events yet</strong><span>Uploads, runs, exports, and profile changes are recorded here.</span></div></td></tr>}</tbody></table></div></div>}
    <footer className="page-footer"><span>RECONCILE <span className="footer-dot">·</span> HISTORY</span><span>Stored locally in SQLite <span className="footer-dot">·</span> UTC event timestamps</span></footer>
  </div>;
}

export default App;
