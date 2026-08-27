import PrintWorkspace from '../features/printing/PrintWorkspace';

/**
 * Scanning is the primary warehouse workflow. Keeping it in the core route
 * bundle avoids a secondary Suspense render between navigation and the live
 * workspace, which can otherwise show as a visual afterimage.
 */
export default function OperationsPage() {
  return <PrintWorkspace />;
}
