import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { get } from './api';
import { n, useLoad } from './util';
import { Login, ChangePassword } from './pages/Login';
import { Overview } from './pages/Overview';
import { Campaigns, CampaignNew, CampaignDetail, CampaignPrint } from './pages/Campaigns';
import { Contacts, ContactImport } from './pages/Contacts';
import { Groups } from './pages/Groups';
import { Messages } from './pages/Messages';
import { Gateways } from './pages/Gateways';
import { OptOuts } from './pages/OptOuts';
import { Alerts } from './pages/Alerts';
import { Audit } from './pages/Audit';
import { Settings } from './pages/Settings';
import { Admins } from './pages/Admins';

const NAV: { to: string; label: string; perm?: string }[] = [
  { to: '/', label: 'Overview' },
  { to: '/campaigns', label: 'Campaigns', perm: 'campaigns.read' },
  { to: '/contacts', label: 'Contacts', perm: 'contacts.read' },
  { to: '/groups', label: 'Groups', perm: 'contacts.read' },
  { to: '/messages', label: 'Needs attention', perm: 'campaigns.read' },
  { to: '/opt-outs', label: 'Opt-outs', perm: 'contacts.read' },
  { to: '/gateways', label: 'Phones', perm: 'gateways.read' },
  { to: '/alerts', label: 'Alerts' },
  { to: '/audit', label: 'Audit log', perm: 'audit.read' },
  { to: '/settings', label: 'Settings' },
  { to: '/admins', label: 'Administrators', perm: 'admins.manage' },
];

function StatusStrip() {
  const { data } = useLoad(() => get('/dashboard/summary'), [], 15_000);
  if (!data) return <div className="strip" />;
  const budget = data.today.daily_segment_budget as number;
  const used = data.today.segments as number;
  return (
    <div className={`strip ${data.kill_switch.enabled ? 'strip-kill' : ''}`}>
      {data.kill_switch.enabled ? (
        <NavLink to="/settings" className="strip-item strip-alarm">
          Kill switch on: nothing is being sent. {data.kill_switch.reason}
        </NavLink>
      ) : (
        <span className="strip-item">Sending allowed</span>
      )}
      <NavLink to="/gateways" className={`strip-item ${data.gateways.online < data.gateways.total || data.gateways.total === 0 ? 'strip-warn' : ''}`}>
        Phones online {data.gateways.online} of {data.gateways.total}
        {data.gateways.paused ? `, ${data.gateways.paused} paused` : ''}
      </NavLink>
      <span className="strip-item" title="SMS segments submitted today against the daily airtime budget">
        Today {n(used)} of {n(budget)} segments
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (used / Math.max(1, budget)) * 100)}%` }} />
        </span>
      </span>
      {data.alerts.n > 0 && (
        <NavLink to="/alerts" className={`strip-item ${data.alerts.critical ? 'strip-alarm' : 'strip-warn'}`}>
          {data.alerts.n} open alert{data.alerts.n === 1 ? '' : 's'}
        </NavLink>
      )}
    </div>
  );
}

export function App() {
  const { me, logout, can } = useAuth();
  const loc = useLocation();
  if (me === undefined) return <div className="boot">Loading…</div>;
  if (me === null) return <Login />;
  if (me.must_change_password) return <ChangePassword forced />;
  if (loc.pathname.endsWith('/print')) {
    return (
      <Routes>
        <Route path="/campaigns/:id/print" element={<CampaignPrint />} />
      </Routes>
    );
  }
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#fff" />
            <path d="M8 9h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-9l-5 4v-4H8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" fill="#2E4C9E" />
          </svg>
          <span>SIM SMS Gateway</span>
        </div>
        <nav>
          {NAV.filter((x) => !x.perm || can(x.perm)).map((x) => (
            <NavLink key={x.to} to={x.to} end={x.to === '/'}>
              {x.label}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <div className="who">
            <strong>{me.display_name}</strong>
            <span>{me.role.replace(/_/g, ' ').toLowerCase()}</span>
          </div>
          <NavLink to="/account">Change password</NavLink>
          <button className="linklike" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="main">
        <StatusStrip />
        <main className="content">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/campaigns/new" element={<CampaignNew />} />
            <Route path="/campaigns/:id" element={<CampaignDetail />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/contacts/import" element={<ContactImport />} />
            <Route path="/groups" element={<Groups />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/opt-outs" element={<OptOuts />} />
            <Route path="/gateways" element={<Gateways />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/admins" element={<Admins />} />
            <Route path="/account" element={<ChangePassword />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
