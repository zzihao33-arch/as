import { Button, Card, Result } from '@arco-design/web-react';
import { ArrowRight, Construction } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface FeaturePageProps {
  title: string;
  description: string;
  actionLabel?: string;
  actionPath?: string;
}

export default function FeaturePage({ title, description, actionLabel, actionPath }: FeaturePageProps) {
  const navigate = useNavigate();

  return (
    <section className="cmhub-page cmhub-feature-page" aria-labelledby="feature-title">
      <Card>
        <Result
          icon={<Construction size={42} aria-hidden="true" />}
          title={<span id="feature-title">{title}</span>}
          subTitle={description}
        />
        {actionLabel && actionPath ? (
          <div className="cmhub-feature-action-slot">
            <Button
              type="primary"
              className="cmhub-feature-action"
              icon={<ArrowRight size={16} />}
              onClick={() => void navigate(actionPath)}
            >
              <span>{actionLabel}</span>
            </Button>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
