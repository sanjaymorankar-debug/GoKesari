# Prompt: newspaper and periodical subscriptions on GoKesari

Drafted 20-Nov-2026 from the owner's request. This is the brief the build in
this folder follows; [DESIGN.md](DESIGN.md) records how it was built and
[TEST_RESULTS.md](TEST_RESULTS.md) what was tested.

---

## The prompt

> Enhance GoKesari's subscription module so that it handles newspapers and
> periodicals as well as milk.
>
> **Today.** The subscription engine (`src/server/services/subscriptions.ts`)
> subscribes a customer to *one* shop product at a time, delivered every day
> or on chosen weekdays, paid from the GoKesari wallet on each delivery day.
> Only dairy and bakery items are marked subscribable, the customer pages
> point only to dairy, there is no newspaper-vendor shop type and no
> newspaper catalogue, and the shop is not told when someone subscribes.
>
> **Build:**
>
> 1. **Newspaper vendor as a shop type.** Add "Newspaper & Magazine Vendor"
>    (`NEWSPAPER_VENDOR`) so any newspaper vendor (paper agent, news stall)
>    registering a shop on gokesari.com can choose it, and can add it as an
>    extra type on an existing shop.
> 2. **A newspaper and periodical catalogue.** Two categories under that
>    type, *Newspapers* and *Magazines & Periodicals*, holding the common
>    Indian titles (English, Hindi, Marathi, Gujarati and other languages)
>    as subscribable products sold by the copy. Each title carries its
>    language, publisher and publication schedule (daily, weekly on a given
>    day, fortnightly, monthly). The vendor adds the titles they sell to
>    their shop the normal way and sets their own price per copy.
> 3. **Schedules that fit periodicals.** Besides "every day" and "selected
>    weekdays", a subscription can deliver on chosen days of the month
>    (1–28): a monthly magazine on the 1st, a fortnightly on the 1st and
>    15th. A weekly magazine uses its issue weekday; a Sunday-only paper uses
>    Sunday.
> 4. **Customer: pick titles, pick a nearby vendor, submit.** A page
>    *Newspapers & magazines* lists every title with filters (newspapers /
>    magazines, language, search). The customer ticks one or more titles,
>    chooses the delivery address, and is shown the vendors near that
>    address who deliver there and carry the titles — most titles carried
>    first, then nearest, with each vendor's price per copy. The customer
>    picks a vendor, checks the schedule and copies for each title (pre-filled
>    from the title's publication schedule), sees the monthly estimate, and
>    submits once. One submission creates one subscription per title, all
>    to that vendor, grouped together. Titles the vendor does not carry are
>    named so the customer can take them from another vendor.
> 5. **Vendor: subscription notice and subscriber list.** On every new
>    subscription (the newspaper flow, the existing single-product flow and
>    a draft being started) the shop owner gets a notice — in-app, plus
>    e-mail/push per their settings — naming the customer, the titles,
>    copies, schedule, start date and delivery area. The shop owner's pages
>    get a *Subscribers* list: every running subscription with customer,
>    address, title, copies, schedule and status, new ones marked.
> 6. **Keep the engine.** Daily order generation, wallet deduction, pause,
>    skip, renewal and cancellation work unchanged for the new
>    subscriptions; milk subscriptions behave exactly as before.
>
> **Test:** unit tests for the month-day schedule; integration tests against
> real PostgreSQL for the catalogue list, the nearby-vendor search, the
> grouped submission (and its refusals), the vendor notice, the subscriber
> list and order generation on the right days; then run it on
> test.gokesari.com through the staging queue and check the pages there.

---

## Decisions taken (owner can change any of these)

The request left these open; the build uses the default in the right-hand
column.

| # | Question | Default used |
|---|---|---|
| 1 | How is a newspaper paid for? | Same as milk: each copy is taken from the customer's GoKesari wallet on its delivery day. (A monthly bill paid to the vendor is a later option.) |
| 2 | Must the vendor accept a new subscriber? | No accept step, as with milk: the subscription starts on its start date and the vendor is told at once. |
| 3 | Who sets the price? | The vendor, per copy, on their shop listing. The catalogue carries no cover price. |
| 4 | One vendor or several per submission? | One vendor per submission. Titles that vendor does not carry are listed; the customer submits them again with another vendor. |
| 5 | Which vendors are shown? | Only vendors who deliver to the chosen address (their radius, delivery PIN codes or society partnership), most selected titles first, then nearest. |
| 6 | Daily orders | One order per title per delivery day (the engine unchanged). Combining a household's titles into one daily order is a later improvement. |
| 7 | Days of the month | 1–28 only, so every month has the day. |
| 8 | Titles not in the list | A vendor or staff can add a title through the normal "add product" flow in the newspaper categories; it appears in the list once approved (schedule defaults: newspapers daily, magazines monthly). |

## Later (not in this build)

- One combined daily order per household for several titles from one vendor.
- Vendor "no paper today" day (newspaper holidays) that skips every
  subscriber's delivery for a date.
- Monthly billing to the vendor instead of per-copy wallet deductions.
- Cover prices and special-edition prices (Sunday price) per title.
