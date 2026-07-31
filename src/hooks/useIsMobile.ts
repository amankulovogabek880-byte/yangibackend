'use client';
import { useEffect, useState } from 'react';

/**
 * Ekran kengligi 768px dan kichik bo'lsa true qaytaradi.
 * Sahifalarda ikki panelli (masalan: ro'yxat + tafsilot) interfeyslarni
 * mobil qurilmada bitta ustunga aylantirish uchun ishlatiladi.
 */
export function useIsMobile(breakpoint: number = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [breakpoint]);
  return isMobile;
}

export default useIsMobile;