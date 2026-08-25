import PrintWorkspace from '../features/printing/PrintWorkspace';

/**
 * Transitional route boundary. The legacy operational workflow remains intact
 * while its feature slices are extracted behind the new app shell.
 */
export default function OperationsPage() {
  return <PrintWorkspace />;
}
