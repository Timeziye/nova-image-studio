'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface WideModeToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

export function WideModeToggle({ enabled, onToggle }: WideModeToggleProps) {
  const Icon = enabled ? PanelLeftClose : PanelLeftOpen;
  const label = enabled ? '退出宽屏' : '宽屏';

  return (
    <Button
      type="button"
      variant={enabled ? 'secondary' : 'outline'}
      size="sm"
      onClick={onToggle}
      className="inline-flex gap-2"
      aria-pressed={enabled}
      title={label}
    >
      <Icon className="w-4 h-4" />
      <span className="hidden lg:inline">{label}</span>
    </Button>
  );
}
