import {
  NavigationFeedbackPlugin as BaseNavigationFeedbackPlugin,
  type NavigationFeedbackStoredTarget,
  PathApi,
  type TElement,
  type TText,
} from 'platejs';
import {
  NavigationFeedbackPlugin,
  type PlateEditor,
  usePluginOptions,
} from 'platejs/react';

/**
 * Plate's navigation flash (a table-of-contents click highlights its heading)
 * marks the target through a hook in every element's props. Upstream that hook
 * is a `useEditorSelector`, so every keystroke and selection change recomputes
 * one jotai selector per element: on a near-limit note about a third of each
 * keystroke. The target only changes when a flash starts or ends, so here each
 * element reads the plugin's `activeTarget` option instead and resolves its own
 * path only while a flash is on. Same attributes on the same element; the flash
 * itself also sets them on the DOM node (`flashTarget`), this keeps them across
 * a re-render.
 */
function useNavigationTarget(
  editor: PlateEditor,
  node: TElement | TText | undefined
) {
  return usePluginOptions(
    BaseNavigationFeedbackPlugin,
    ({
      activeTarget,
    }: {
      activeTarget: NavigationFeedbackStoredTarget | null;
    }) => {
      const path = activeTarget?.pathRef.current;
      if (!(activeTarget && path && node)) return null;
      const own = editor.api.findPath(node);
      return own && PathApi.equals(own, path) ? activeTarget : null;
    }
  );
}

export const navigationFeedbackPlugin = NavigationFeedbackPlugin.extend({
  inject: {
    nodeProps: {
      transformProps: ({ editor, element, props, text }) => {
        // Plate runs node-prop transforms in each element's render, in a fixed order.
        const target = useNavigationTarget(editor, element ?? text);
        if (!target) return props;
        return {
          ...props,
          'data-nav-cycle': String(target.cycle),
          'data-nav-highlight': target.variant,
          'data-nav-pulse': String(target.pulse),
          'data-nav-target': 'true',
          style: {
            ...props.style,
            '--plate-nav-feedback-duration': `${target.duration}ms`,
          },
        };
      },
    },
  },
});
