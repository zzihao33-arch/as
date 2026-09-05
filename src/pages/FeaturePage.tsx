import { Button, Card } from 'tdesign-react';
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
      <Card className="cmhub-feature-card" headerBordered hoverShadow>
        <div className="cmhub-feature-result">
          <Construction size={42} aria-hidden="true" />
          <h1 id="feature-title">{title}</h1>
          <p>{description}</p>
        </div>
        {actionLabel && actionPath ? (
          <div className="cmhub-feature-action-slot">
            <Button
              theme="primary"
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
