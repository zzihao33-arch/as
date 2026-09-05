import { Button, Card } from 'tdesign-react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
  retryKey: number;
}

const RUNTIME_ERROR_STORAGE_KEY = 'cmhub:last-runtime-error';

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public state: AppErrorBoundaryState = {
    error: null,
    retryKey: 0,
  };

  public static getDerivedStateFromError(error: Error): Pick<AppErrorBoundaryState, 'error'> {
    return { error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    try {
      window.sessionStorage.setItem(RUNTIME_ERROR_STORAGE_KEY, JSON.stringify({
        message: error.message,
        componentStack: errorInfo.componentStack,
        path: window.location.pathname,
        occurredAt: Date.now(),
      }));
    } catch {
      // Diagnostics must never prevent the user from recovering the workbench.
    }

    console.error('CM-HUB application error recovered by boundary:', error, errorInfo);
  }

  private retryCurrentPage = () => {
    // React.lazy caches a rejected import promise. A local remount therefore
    // cannot recover from a stale deployment chunk; a reload preserves the URL
    // and requests the current asset manifest before mounting the workspace.
    window.location.reload();
  };

  public render() {
    if (this.state.error) {
      return (
        <main className="cmhub-app-recovery" role="alert" aria-live="assertive">
          <Card className="cmhub-app-recovery-card">
            <div className="cmhub-app-recovery-result">
              <AlertTriangle size={42} aria-hidden="true" />
              <h1>工作台遇到异常，已保护当前页面地址</h1>
              <p>请重新打开当前工作区；本机已保存的数据不会因本次异常被清除</p>
              <Button theme="primary" icon={<RefreshCw size={16} />} onClick={this.retryCurrentPage}>
                重新打开当前工作区
              </Button>
            </div>
          </Card>
        </main>
      );
    }

    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}
