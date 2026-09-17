import { Card } from '@arco-design/web-react';
import BolManager from '../features/bol/BolManager';
import { AirPickupModuleHeader } from '../features/airPickup/AirPickupModuleHeader';

export default function BolPage() {
  return (
    <section className="cmhub-page cmhub-air-page" aria-labelledby="air-management-title">
      <AirPickupModuleHeader showBackToPickups />
      <Card className="cmhub-module-frame">
        <BolManager />
      </Card>
    </section>
  );
}
