interface OrderSummaryProps {
  total: number;
  itemCount: number;
}

export function OrderSummary({ total, itemCount }: OrderSummaryProps) {
  return (
    <div className="order-summary">
      <span>{itemCount} items</span>
      <strong>{total}</strong>
    </div>
  );
}
