# `<details>` HTML details disclosure element

<details>
<summary>Baseline Widely available \*</summary>

This feature is well established and works across many devices and browser versions. It’s been available across browsers since January 2020.

\* Some parts of this feature may have varying levels of support.

- [See full compatibility](#browser_compatibility)
- [Learn more](https://developer.mozilla.org/en-US/docs/Glossary/Baseline/Compatibility)

</details>

The **`<details>`** [HTML](https://developer.mozilla.org/en-US/docs/Web/HTML) element creates a disclosure widget in which information is visible only when the widget is toggled into an open state. A summary or label must be provided using the [`<summary>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/summary) element.

A disclosure widget is typically presented onscreen using a small triangle that rotates (or twists) to indicate open/closed state, with a label next to the triangle. The contents of the `<summary>` element are used as the label for the disclosure widget. The contents of the `<details>` provide the [accessible description](https://developer.mozilla.org/en-US/docs/Glossary/Accessible_description) for the `<summary>`.

<a id="try_it"></a>
## [Try it](#try_it)

```
<details>
  <summary>Details</summary>
  Something small enough to escape casual notice.
</details>
```

```
details {
  border: 1px solid #aaaaaa;
  border-radius: 4px;
  padding: 0.5em 0.5em 0;
}

summary {
  font-weight: bold;
  margin: -0.5em -0.5em 0;
  padding: 0.5em;
}

details[open] {
  padding: 0.5em;
}

details[open] summary {
  border-bottom: 1px solid #aaaaaa;
  margin-bottom: 0.5em;
}
```

<a id="attributes"></a>
## [Attributes](#attributes)

This element includes the [global attributes](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes).

**[`open`](#open)**
This Boolean attribute indicates whether the details — that is, the contents of the `<details>` element — are currently visible. The details are shown when this attribute exists, or hidden when this attribute is absent. By default this attribute is absent which means the details are not visible.

> [!NOTE]
> You have to remove this attribute entirely to make the details hidden. `open="false"` makes the details visible because this attribute is Boolean.

**[`name`](#name)**
This attribute enables multiple `<details>` elements to be connected, with only one open at a time. This allows developers to easily create UI features such as accordions without scripting.

The `name` attribute specifies a group name — give multiple `<details>` elements the same `name` value to group them. Only one of the grouped `<details>` elements can be open at a time — opening one will cause another to close. If multiple grouped `<details>` elements are given the `open` attribute, only the first one in the source order will be rendered open.

> [!NOTE]
> `<details>` elements don't have to be adjacent to one another in the source to be part of the same group.

<a id="usage_notes"></a>
## [Usage notes](#usage_notes)

A `<details>` widget can be in one of two states. The default *closed* state displays only the triangle and the label inside `<summary>` (or a [user agent](https://developer.mozilla.org/en-US/docs/Glossary/User_agent)-defined default string if no `<summary>`).

When the user clicks on the widget or focuses it then presses the space bar, it "twists" open, revealing its contents. The common use of a triangle which rotates or twists around to represent opening or closing the widget is why these are sometimes called "twisty".

You can programmatically open and close the widget by setting/removing its [`open`](#open) attribute.

<a id="styling_the_details_element"></a>
### [Styling the `<details>` element](#styling_the_details_element)

The `<details>` element can be thought of as a container of two elements: the `<summary>` element, which is visible both when expanded and collapsed; and the [`::details-content`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::details-content) pseudo-element, whose contents are hidden when collapsed.

The `<summary>` element is automatically given a [`display`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/display) value of `list-item`. You can style the marker just like a list marker, using [`list-style-type`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/list-style-type), [`list-style-position`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/list-style-position), [`::marker`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::marker), etc. See also [Changing the summary's icon](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/summary#changing_the_summarys_icon).

The [`::details-content`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::details-content) pseudo-element enables you to animate the transition between open and closed. See the [`::details-content` reference page](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::details-content#transition_example) for an example.

<a id="events"></a>
### [Events](#events)

In addition to the usual events supported by HTML elements, the `<details>` element supports the [`toggle`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/toggle_event "toggle") event, which is dispatched to the `<details>` element whenever its state changes between open and closed. It is sent *after* the state is changed, although if the state changes multiple times before the browser can dispatch the event, the events are coalesced so that only one is sent.

You can use an event listener for the `toggle` event to detect when the widget changes state:

js

```
details.addEventListener("toggle", (event) => {
  if (details.open) {
    /* the element was toggled open */
  } else {
    /* the element was toggled closed */
  }
});
```

<a id="examples"></a>
## [Examples](#examples)

<a id="a_basic_disclosure_example"></a>
### [A basic disclosure example](#a_basic_disclosure_example)

This example shows a basic `<details>` element with a `<summary>`.

html

```
<details>
  <summary>System Requirements</summary>
  <p>
    Requires a computer running an operating system. The computer must have some
    memory and ideally some kind of long-term storage. An input device as well
    as some form of output device is recommended.
  </p>
</details>
```

<a id="result"></a>
#### Result

<a id="creating_an_open_disclosure_box"></a>
### [Creating an open disclosure box](#creating_an_open_disclosure_box)

To start the `<details>` box in its open state, add the Boolean `open` attribute:

html

```
<details open>
  <summary>System Requirements</summary>
  <p>
    Requires a computer running an operating system. The computer must have some
    memory and ideally some kind of long-term storage. An input device as well
    as some form of output device is recommended.
  </p>
</details>
```

<a id="result_2"></a>
#### Result

<a id="multiple_named_disclosure_boxes"></a>
### [Multiple named disclosure boxes](#multiple_named_disclosure_boxes)

We include several `<details>` boxes, all with the same name so only one can be open at a time:

html

```
<details name="requirements">
  <summary>Graduation Requirements</summary>
  <p>
    Requires 40 credits, including a passing grade in health, geography,
    history, economics, and wood shop.
  </p>
</details>
<details name="requirements">
  <summary>System Requirements</summary>
  <p>
    Requires a computer running an operating system. The computer must have some
    memory and ideally some kind of long-term storage. An input device as well
    as some form of output device is recommended.
  </p>
</details>
<details name="requirements">
  <summary>Job Requirements</summary>
  <p>
    Requires knowledge of HTML, CSS, JavaScript, accessibility, web performance,
    privacy, security, and internationalization, as well as a dislike of
    broccoli.
  </p>
</details>
```

<a id="result_3"></a>
#### Result

Try opening all the disclosure widgets. When you open one, all the others automatically close.

<a id="customizing_the_appearance"></a>
### [Customizing the appearance](#customizing_the_appearance)

Now let's apply some CSS to customize the appearance of the disclosure box.

<a id="css"></a>
#### CSS

css

```
details {
  font:
    16px "Open Sans",
    "Calibri",
    sans-serif;
  width: 620px;
}

details > summary {
  padding: 2px 6px;
  width: 15em;
  background-color: #dddddd;
  border: none;
  box-shadow: 3px 3px 4px black;
  cursor: pointer;
}

details > p {
  border-radius: 0 0 10px 10px;
  background-color: #dddddd;
  padding: 2px 6px;
  margin: 0;
  box-shadow: 3px 3px 4px black;
}

details:open > summary {
  background-color: #ccccff;
}
```

This CSS creates a look similar to a tabbed interface, where clicking the tab opens it to reveal its contents.

> [!NOTE]
> In browsers that don't support the [`:open`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/:open) pseudo-class, you can use the attribute selector `details[open]` to style the `<details>` element when it is in the open state.

<a id="html"></a>
#### HTML

html

```
<details>
  <summary>System Requirements</summary>
  <p>
    Requires a computer running an operating system. The computer must have some
    memory and ideally some kind of long-term storage. An input device as well
    as some form of output device is recommended.
  </p>
</details>
```

<a id="result_4"></a>
#### Result

See the [`<summary>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/summary) page for an [example of customizing the disclosure widget](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/summary#changing_the_summarys_icon).

<a id="technical_summary"></a>
## [Technical summary](#technical_summary)

| [Content categories](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories) | [Flow content](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories#flow_content), sectioning root, interactive content, palpable content. |
| --- | --- |
| Permitted content | One [`<summary>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/summary) element followed by [flow content](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories#flow_content). |
| Tag omission | None, both the starting and ending tag are mandatory. |
| Permitted parents | Any element that accepts [flow content](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories#flow_content). |
| Implicit ARIA role | [`group`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/group_role) |
| Permitted ARIA roles | No `role` permitted |
| DOM interface | [`HTMLDetailsElement`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDetailsElement) |

<a id="specifications"></a>
## [Specifications](#specifications)

| Specification |
| --- |
| [HTML<br>\# the-details-element](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-details-element) |

<a id="browser_compatibility"></a>
## [Browser compatibility](#browser_compatibility)

<a id="see_also"></a>
## [See also](#see_also)

- [`<summary>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/summary)
- [`::details-content`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::details-content)

<a id="feedback"></a>
## Help improve MDN

[Learn how to contribute](https://developer.mozilla.org/en-US/docs/MDN/Community/Getting_started)

This page was last modified on Oct 16, 2026 by [MDN contributors](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details/contributors.txt).

[View this page on GitHub](https://github.com/mdn/content/blob/main/files/en-us/web/html/reference/elements/details/index.md?plain=1 "Folder: en-us/web/html/reference/elements/details (Opens in a new tab)") • [Report a problem with this content](https://github.com/mdn/content/issues/new?template=page-report.yml&mdn-url=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FHTML%2FReference%2FElements%2Fdetails&metadata=%3C%21--+Do+not+make+changes+below+this+line+--%3E%0A%3Cdetails%3E%0A%3Csummary%3EPage+report+details%3C%2Fsummary%3E%0A%0A*+Folder%3A+%60en-us%2Fweb%2Fhtml%2Freference%2Felements%2Fdetails%60%0A*+MDN+URL%3A+https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FHTML%2FReference%2FElements%2Fdetails%0A*+GitHub+URL%3A+https%3A%2F%2Fgithub.com%2Fmdn%2Fcontent%2Fblob%2Fmain%2Ffiles%2Fen-us%2Fweb%2Fhtml%2Freference%2Felements%2Fdetails%2Findex.md%0A*+Last+commit%3A+https%3A%2F%2Fgithub.com%2Fmdn%2Fcontent%2Fcommit%2F44a1a0348720bbd1b1085c7d92b93b4fd311a3dd%0A*+Document+last+modified%3A+2026-10-16T19%3A18%3A57.000Z%0A%0A%3C%2Fdetails%3E "This will take you to GitHub to file a new issue.")
