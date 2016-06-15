import { Handle } from 'dojo-core/interfaces';
import Promise from 'dojo-core/Promise';
import Set from 'dojo-core/Set';
import Map from 'dojo-core/Map';
import { place, Position } from 'dojo-dom/dom';
import { createProjector, Projector } from 'dojo-widgets/projector';
import { ParentListMixin } from 'dojo-widgets/mixins/createParentListMixin';

import {
	CombinedRegistry,
	WidgetLike
} from './createApp';

interface CustomElement {
	children: CustomElement[];
	element: Element;
	is: string;
	widget?: WidgetLike;
}

function normalizeTagName(tagName: string) {
	// Ensure uppercase ASCII letters are converted to lowercase.
	// See <https://www.w3.org/TR/custom-elements/#valid-custom-element-name>.
	// TODO: Test with non-ASCII uppercase letters (which shouldn't be lowercased).
	return tagName.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function isCustomElement(is: string): boolean {
	return is === 'projection-surface' || is === 'attach-widget';
}

function getCustomElementsByProjectionSurface (root: Element): CustomElement[] {
	const allElements: Element[] = Array.prototype.slice.call(root.getElementsByTagName('*'));
	allElements.unshift(root); // Be inclusive!

	const customElements: CustomElement[] = [];
	for (const element of allElements) {
		const attrIs = element.getAttribute('is');
		const tagName = normalizeTagName(element.tagName);

		// The `is` attribute takes precedence over the tag name.
		if (attrIs ? isCustomElement(attrIs) : isCustomElement(tagName)) {
			customElements.push({ children: [], element, is: attrIs || tagName });
		}
	}

	// A list of trees, reconstructed from the `customElements`.
	const surfaces: CustomElement[] = [];
	// Inverse stack of the nodes in the current tree. The deepest node is at the start of the list.
	const inverseStack: CustomElement[] = [];

	const discardFirstNode = (element: Element) => {
		if (inverseStack.length === 0) {
			return false;
		}

		// Return `true` if the top-most element in the stack does *not* contain `element`.
		return !(inverseStack[0].element.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_CONTAINED_BY);
	};

	// `customElements` is a flat list of elements, in document order. Reconstruct a tree structure where each
	// root is assumed to be a projection surface.
	for (const custom of customElements) {
		// Remove nodes from the stack that do not contain the element.
		while (discardFirstNode(custom.element)) {
			inverseStack.shift();
		}

		// Start a new tree if the element is not contained in any existing node.
		if (inverseStack.length === 0) {
			// Don't costruct an invalid tree.
			if (custom.is !== 'projection-surface') {
				throw new Error('Custom tags must be rooted in a projection-surface');
			}

			surfaces.push(custom);
		}
		// Add the element to the deepest node it is contained by.
		else {
			// Don't costruct an invalid tree.
			if (custom.is === 'projection-surface') {
				throw new Error('projection-surface cannot contain another projection-surface');
			}

			inverseStack[0].children.push(custom);
		}

		// Prepare for the next iteration.
		inverseStack.unshift(custom);
	}

	return surfaces;
}

function resolveAttachWidget (registry: CombinedRegistry, element: Element): Promise<WidgetLike> {
	// Resolve the widget instance ID. The `data-widget-id` attribute takes precedence over `id`.
	const attrWidgetId = element.getAttribute('data-widget-id');
	const attrId = element.getAttribute('id');
	const id = attrWidgetId || attrId;
	if (!id) {
		throw new Error('Cannot resolve widget for a custom element without \'data-widget-id\' or \'id\' attributes');
	}

	return registry.getWidget(id);
}

const noop = () => {};

export default function realizeCustomElements(registry: CombinedRegistry, root: Element): Promise<Handle> {
	// Bottom up, breadth first queue of custom elements who's children's widgets need to be appended to
	// their own widget. Combined for all projection surfaces.
	const appendQueue: CustomElement[] = [];
	// For each projector, track the immediate custom element descendants. These placeholder
	// elements will be replaced with rendered widgets.
	const immediatePlaceholderLookup = new Map<Projector, CustomElement[]>();
	// Projectors for each projection surface.
	const projectors: Projector[] = [];

	// Return a new promise here so API errors can be thrown in the executor, while still resulting in a
	// promise rejection.
	return new Promise<WidgetLike[]>((resolve) => {
		// Flat list of all widgets that are being loaded.
		const loadedWidgets: Promise<WidgetLike>[] = [];

		const surfaces = getCustomElementsByProjectionSurface(root);
		for (const { children, element: root } of surfaces) {
			const projector = createProjector({ root });
			immediatePlaceholderLookup.set(projector, children);
			projectors.push(projector);

			// Recursion-free, depth first processing of the surface tree.
			let processing = [children];
			while (processing.length > 0) {
				for (const custom of processing.shift()) {
					// TODO: This currently assumes `is === 'attach-widget'`
					const promise = resolveAttachWidget(registry, custom.element).then((widget) => {
						// Store the widget for easy access.
						return custom.widget = widget;
					});
					loadedWidgets.push(promise);

					if (custom.children.length > 0) {
						// Ensure the children are processed.
						processing.push(custom.children);
						// Ensure the children are appended to their parent.
						appendQueue.unshift(custom);
					}
				}
			}
		}

		// Wait for all widgets to be loaded in parallel.
		resolve(Promise.all(loadedWidgets));
	}).then((widgets) => {
		// Guard against improper widget usage.
		const uniques = new Set(widgets);
		if (uniques.size !== widgets.length) {
			throw new Error('Cannot attach a widget multiple times');
		}
		for (const widget of widgets) {
			// <any> hammer because `widget` could be anything.
			if ((<any> widget).parent) {
				throw new Error('Cannot attach a widget that already has a parent');
			}
		}

		// Build up the widget hierarchy.
		for (const custom of appendQueue) {
			// Assume the widget has the ParentListMixin.
			const parent = <WidgetLike & ParentListMixin<WidgetLike>> custom.widget;
			const widgets = custom.children.map(child => child.widget);
			parent.append(widgets);
		}

		// Attach all projectors at the same time.
		const attachedProjectors = projectors.map((projector) => {
			const immediatePlaceholders = immediatePlaceholderLookup.get(projector);
			immediatePlaceholderLookup.delete(projector);

			// Append the top-level widgets to the projector.
			projector.append(immediatePlaceholders.map(custom => custom.widget));

			// Get ready to replace the placeholder elements as soon as the widgets have rendered.
			const handle = projector.on('attach', () => {
				handle.destroy();

				const { root } = projector;
				// Rendered widgets start at this offset.
				const offset = root.childNodes.length - immediatePlaceholders.length;
				for (const { element: placeholder } of immediatePlaceholders) {
					place(root.childNodes[offset], Position.Replace, placeholder);
				}
			});

			// Now attach the projector.
			return projector.attach({ type: 'merge' });
		});

		// Wait for the projectors to be attached.
		return Promise.all(attachedProjectors);
	}).then(() => {
		return {
			destroy() {
				this.destroy = noop;
				for (const p of projectors) {
					p.destroy();
				}
				// TODO: Instances from the registry should *not* be destroyed when the returned handle is
				// destroyed, however instances created on the fly from tag registries *should* be.
			}
		};
	});
};
