import { useGSAP } from '@gsap/react';
import { gsap } from 'gsap';

gsap.registerPlugin(useGSAP);

type MotionScope = { current: HTMLElement | null };

type WorkbenchMotionOptions = {
  /** Replays only the active tab/panel transition when this value changes. */
  tabKey?: string;
};

const precisionPointerQuery = '(hover: hover) and (pointer: fine)';
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

/**
 * Small, scoped motion for operational workspaces. It never touches data-bearing
 * elements outside the supplied root and GSAP reverts all inline styles/listeners
 * when the component unmounts or its tab key changes.
 */
export function useWorkbenchMotion(scope: MotionScope, { tabKey }: WorkbenchMotionOptions = {}) {
  useGSAP((_, contextSafe) => {
    const root = scope.current;
    if (!root || window.matchMedia(reducedMotionQuery).matches) return undefined;

    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-motion-enter]'));
    if (targets.length) {
      gsap.timeline({ defaults: { duration: 0.34, ease: 'power2.out' } })
        .fromTo(
          targets,
          { autoAlpha: 0, y: 8 },
          {
            autoAlpha: 1,
            y: 0,
            stagger: 0.035,
            clearProps: 'transform,visibility,opacity',
          },
        );
    }

    const media = gsap.matchMedia();
    media.add(precisionPointerQuery, () => {
      const hoverTargets = Array.from(root.querySelectorAll<HTMLElement>('[data-motion-hover]'));
      if (!hoverTargets.length || !contextSafe) return undefined;

      const onPointerEnter = contextSafe((event: PointerEvent) => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) return;
        gsap.to(target, {
          y: -2,
          scale: 1.002,
          duration: 0.16,
          ease: 'power2.out',
          overwrite: 'auto',
        });
      });
      const onPointerLeave = contextSafe((event: PointerEvent) => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) return;
        gsap.to(target, {
          y: 0,
          scale: 1,
          duration: 0.2,
          ease: 'power2.out',
          overwrite: 'auto',
          clearProps: 'transform',
        });
      });

      hoverTargets.forEach(target => {
        target.addEventListener('pointerenter', onPointerEnter);
        target.addEventListener('pointerleave', onPointerLeave);
      });

      return () => {
        hoverTargets.forEach(target => {
          target.removeEventListener('pointerenter', onPointerEnter);
          target.removeEventListener('pointerleave', onPointerLeave);
        });
      };
    });

    return () => media.revert();
  }, { scope });

  useGSAP(() => {
    const root = scope.current;
    if (!root || !tabKey || window.matchMedia(reducedMotionQuery).matches) return undefined;

    const panel = root.querySelector<HTMLElement>('[data-motion-tab]');
    if (!panel) return undefined;

    gsap.fromTo(
      panel,
      { autoAlpha: 0, y: 6 },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.22,
        ease: 'power2.out',
        clearProps: 'transform,visibility,opacity',
      },
    );

    return undefined;
  }, { scope, dependencies: [tabKey], revertOnUpdate: true });
}
