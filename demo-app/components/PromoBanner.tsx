interface PromoBannerProps {
  code: string;
}

export function PromoBanner({ code }: PromoBannerProps) {
  return <div className="promo-banner">{code}</div>;
}
