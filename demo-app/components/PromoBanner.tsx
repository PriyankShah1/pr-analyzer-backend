interface PromoBannerProps {
  code: string;
  discountPercent: number;
}

export function PromoBanner({ code, discountPercent }: PromoBannerProps) {
  return (
    <div className="promo-banner">
      {code} — {discountPercent}% off
    </div>
  );
}
