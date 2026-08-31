import { FileCheck2, Plane } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';

export function AirPickupModuleHeader({ action }: { action?: ReactNode }) {
  const warehouseSession = useWarehouseSession();
  const sections = [
    {
      key: 'pickups',
      label: '提货单',
      path: '/air-pickups',
      permission: 'air_pickups.view',
      icon: Plane,
      end: true,
    },
    {
      key: 'documents',
      label: '交仓凭证',
      path: '/air-pickups/handover-documents',
      permission: 'bol.view',
      icon: FileCheck2,
      end: false,
    },
  ].filter(section => warehouseSession.hasPermission(section.permission));

  return (
    <div className="cmhub-air-module-header">
      <header className="cmhub-page-heading">
        <div>
          <h1 id="air-management-title">空提管理</h1>
          <p>集中处理空运提货单流转与交仓凭证。</p>
        </div>
        {action}
      </header>
      <nav className="cmhub-air-section-nav" aria-label="空提管理功能">
        {sections.map(section => {
          const Icon = section.icon;
          return (
            <NavLink
              key={section.key}
              to={section.path}
              end={section.end}
              className={({ isActive }) => isActive ? 'is-active' : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{section.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
