import { useEffect, useState } from 'react';
import { OrderSummary } from './OrderSummary';
import { PromoBanner } from './PromoBanner';

export function CheckoutPanel({ cartId }: { cartId: string }) {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    fetchTotal(cartId).then(setTotal);
  }, []);

  return (
    <div className="checkout-panel">
      <OrderSummary total={total} itemCount={3} />
      <PromoBanner code={cartId} discountPercent={10} />
    </div>
  );
}
