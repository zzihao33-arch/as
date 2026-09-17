import { ArrowLeft, FileCheck2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';

type AirPickupModuleHeaderProps = {
  action?: ReactNode;
  showDocumentsLink?: boolean;
  showBackToPickups?: boolean;
};

export function AirPickupModuleHeader({ action, showDocumentsLink = false, showBackToPickups = false }: AirPickupModuleHeaderProps) {
  const warehouseSession = useWarehouseSession();
  const canViewDocuments = warehouseSession.hasPermission('bol.view');

  return (
    <div className="cmhub-air-module-header">
      <header className="cmhub-page-heading">
        <div>
          <h1 id="air-management-title">空提管理</h1>
          <p>在一个工作台内处理提货单、流转记录与交仓凭证。</p>
        </div>
        <div className="cmhub-air-header-actions">
          {showBackToPickups && <Link className="cmhub-air-document-link cmhub-air-back-link" to="/air-pickups">
            <ArrowLeft size={15} aria-hidden="true" />
            <span>返回提单列表</span>
          </Link>}
          {showDocumentsLink && canViewDocuments && <Link className="cmhub-air-document-link" to="/air-pickups/handover-documents">
            <FileCheck2 size={15} aria-hidden="true" />
            <span>交仓凭证</span>
          </Link>}
          {action}
        </div>
      </header>
    </div>
  );
}
