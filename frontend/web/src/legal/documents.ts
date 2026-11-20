/**
 * The Terms of Service and the Privacy Policy the A1 checkbox refers to (§6.3, ADR 0036),
 * shown in a dialog on A1 and served from the portal at `/legal/terms/` and
 * `/legal/privacy/`.
 *
 * This is a sample draft, written from what the product does (spec §5, §13, §17) and not
 * reviewed by a lawyer. Every fact that is not decided yet is a bracketed placeholder:
 * the legal entity (§20 item 2), the hosting region, the governing law. The page says so
 * above the text. Both documents share `TERMS_VERSION`: accepting the version accepts both.
 *
 * English only. The chrome around the text is translated; the text is not, and the page
 * says that too when the portal is in another language.
 */

export type LegalSection = { heading: string; paragraphs: string[] };
export type LegalDocument = { id: 'terms' | 'privacy'; sections: LegalSection[] };

export const COMPANY_PLACEHOLDER = '[Company legal name]';

export const TERMS_OF_SERVICE: LegalDocument = {
  id: 'terms',
  sections: [
    {
      heading: 'Who we are and what these terms cover',
      paragraphs: [
        `Oraly is operated by ${COMPANY_PLACEHOLDER} ("we", "us"). These terms are the agreement between us and the business that opens a workspace ("you"). They cover the portal, the phone agents you build in it, the phone numbers you buy or connect through it, and the credits you pay with.`,
        'Oraly is a service for businesses. By opening a workspace you confirm that you are acting for a business and that you may bind it to these terms.',
      ],
    },
    {
      heading: 'Your account and your workspace',
      paragraphs: [
        'A workspace belongs to one owner. The owner can invite other people as admins, editors or viewers, and can hand ownership to someone else. You are responsible for what the people you invite do in the workspace, and for keeping your sign-in details private. Two-factor sign-in is available in Settings, and we require it for owners and admins once a card is on file or the balance is above a set amount.',
        'Tell us at once if you believe someone else has used your account.',
      ],
    },
    {
      heading: 'What the service does',
      paragraphs: [
        'You describe your business, your hours and the rules your agent should follow. Oraly turns that into a phone agent that answers calls on a number you buy through us or on a line you forward or connect, speaks with the caller, captures what you asked it to capture, and shows you a summary, and where enabled a recording and a transcript, in the dashboard.',
        'The agent is software. It can mishear, misunderstand or give an answer you did not intend. You remain responsible for what your business promises to callers, and for checking what the agent captured before you act on it.',
      ],
    },
    {
      heading: 'Credits, packs and payment',
      paragraphs: [
        'The service is prepaid. You buy a pack of credits, and calls draw them down: one credit per minute on the Standard tier and one and a half credits per minute on the Premium tier, measured by the second. A phone number rented through us costs a monthly amount of credits, charged when the number goes live and on the same day each month after that. The current prices and pack sizes are shown in the portal before you pay.',
        'Credits expire twelve months after the purchase that created them and are used oldest first. Credits are not refundable except where the law requires a refund. So that a call is never cut off mid-sentence, we allow a small overdraft; it is settled from your next purchase.',
        'Auto top-up is off unless you turn it on. When it is on, we charge the card on file for the pack you chose when your balance falls below the level you set, and we tell you by email each time.',
        'Payments are taken by our payment processor. We do not see or store your card number.',
      ],
    },
    {
      heading: 'The free trial',
      paragraphs: [
        'A new workspace receives a small number of trial credits for test calls from the browser. No card is needed. A phone number, and calls from the public, are available once you have bought a pack.',
      ],
    },
    {
      heading: 'Your content',
      paragraphs: [
        'What you put into the workspace stays yours: your business description, the documents and knowledge you upload, your call recordings and transcripts, and the summaries your agent produces. You give us permission to store and process that content to run the service for you, and for no other purpose.',
        'You confirm that you have the right to upload what you upload, and that nothing in it is unlawful or infringes someone else’s rights.',
      ],
    },
    {
      heading: 'Acceptable use',
      paragraphs: [
        'You may not use Oraly to make or receive calls that are unlawful where you or the caller are, to impersonate another business, to harass anyone, or to collect payment card numbers, government identification numbers or health, legal or financial details beyond what your own business legitimately needs. The agent is built to refuse card and identification numbers, and you may not try to remove that limit.',
        'Outbound calls are available only after we have verified your business, with a verified caller ID, inside the calling hours of the destination, to people who have called you before and are not on a do-not-call list. You must honour every request not to be called.',
        'We may pause an agent, a number or a workspace that breaks these rules. Where we reasonably can, we will tell you first.',
      ],
    },
    {
      heading: 'Recording calls and telling callers',
      paragraphs: [
        'You choose whether your agent records calls and how long recordings and transcripts are kept. The law on recording and on consent differs by country, province and state. You are responsible for knowing the rules that apply to you and your callers and for telling callers as those rules require. Oraly can add a recording notice at the start of every call; it is on unless you turn it off.',
      ],
    },
    {
      heading: 'Availability',
      paragraphs: [
        'We rely on telephony, voice and payment providers to run the service, and we work to keep it available at all times, but we do not promise uninterrupted service. An incoming call is declined, and the caller hears a busy tone, when your workspace is paused, when your balance is empty, when your plan’s limit on simultaneous calls is reached, or outside the answering hours you set.',
      ],
    },
    {
      heading: 'Limits on our liability',
      paragraphs: [
        'To the extent the law allows, we are not liable for indirect losses, lost profit or lost business arising from the service, and our total liability to you for any claim is limited to the amount you paid us in the twelve months before the claim arose. Nothing in these terms limits liability that the law does not allow us to limit.',
      ],
    },
    {
      heading: 'Ending the service',
      paragraphs: [
        'You can stop using Oraly at any time. The owner can ask us to delete the workspace from Settings; we release its phone numbers, remove its content as described in the Privacy Policy, and any unused credits are forfeited. We may suspend or end a workspace for non-payment or for a breach of these terms.',
      ],
    },
    {
      heading: 'Changes to these terms',
      paragraphs: [
        'We may change these terms. When we do, we will ask you to read and accept the new version the next time you sign in, and the version date at the top of this page will change. Continuing to use the service after accepting is your agreement to the new version.',
      ],
    },
    {
      heading: 'Governing law',
      paragraphs: [
        'These terms are governed by the laws of [Province or state], [Country], and any dispute will be heard by the courts there, except where the law of the place where you are gives you rights that cannot be taken away.',
      ],
    },
  ],
};

export const PRIVACY_POLICY: LegalDocument = {
  id: 'privacy',
  sections: [
    {
      heading: 'What this policy covers',
      paragraphs: [
        `This policy explains what ${COMPANY_PLACEHOLDER} ("we", "us") collects when a business uses Oraly, and what happens to the details of the people who call that business’s agent. It covers the portal, the agents and the phone numbers run through it.`,
      ],
    },
    {
      heading: 'What we collect',
      paragraphs: [
        'About the people who use the portal: name, email address, the sign-in method, the time and address of each sign-in, and the language and theme chosen in the browser.',
        'About the workspace: the business name, country and time zone, the description of the business and its hours, the documents and knowledge uploaded for the agent, the phone numbers bought or connected, and the settings chosen for each agent.',
        'About each call: the caller’s phone number, when the call started and how long it lasted, the agent that answered, and the summary and the fields the business asked the agent to capture. When recording is on, the recording and the transcript as well.',
        'About billing: the packs bought, the invoices, and the state of auto top-up. Card details are entered on our payment processor’s pages and stay there; we keep only a reference to them.',
        'About use of the portal: which screens are opened and which actions are taken, by account and workspace id, plus error reports. Never the text of a brief, a transcript, an email address or a phone number.',
      ],
    },
    {
      heading: 'Why we use it',
      paragraphs: [
        'To run the agent and answer calls, to show the business what happened on each call, to charge for the minutes used, to answer support requests, to keep accounts and the service secure, and to understand which parts of the portal are used so that we can improve them.',
        'We do not sell personal information, and we do not use it for advertising.',
      ],
    },
    {
      heading: 'People who call an agent',
      paragraphs: [
        'When someone calls a business’s agent, we process their number and what they say on behalf of that business, which decides whether calls are recorded, how long call data is kept, and who in its team can see it. A caller who wants to know what a business holds about them, or wants it removed, should ask that business. We help the business meet such a request.',
      ],
    },
    {
      heading: 'Who processes it for us',
      paragraphs: [
        'Oraly is hosted on Amazon Web Services in [Hosting region]. Payments are taken by Stripe. Sign-in, telephony, speech and the language model that runs the conversation, email delivery, product analytics and error reporting are provided by specialist companies under contracts that limit what they may do with the data to running the service for us. We do not name every provider here because they can change; the list is available on request.',
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        'Recordings and transcripts are kept for the period the workspace owner sets in Settings, between seven days and one year, and are then removed from our systems and from the voice provider. The billing facts of a call (when it happened, how long it lasted, what it cost) are kept with the invoices for as long as tax and accounting law requires. Account and workspace details are kept until the workspace is deleted.',
        'When an owner asks us to delete a workspace, we release its numbers, remove its content and keep only what the law requires us to keep.',
      ],
    },
    {
      heading: 'How we protect it',
      paragraphs: [
        'Data moves between your browser, our servers and our providers over encrypted connections. Access inside a workspace follows the role each member was given, and the owner can require two-factor sign-in. Our staff can open a workspace only in read-only mode, with a recorded reason, and every such action is logged.',
      ],
    },
    {
      heading: 'Your choices',
      paragraphs: [
        'From Settings, an owner or admin can turn recording off for new agents, set how long call data is kept, download a copy of everything the workspace holds, and ask us to delete the workspace. Anyone with an account can see where they are signed in and end a session, and can change their name and password.',
        'To see, correct or remove the personal details we hold about you, write to us at the address below.',
      ],
    },
    {
      heading: 'Cookies and local storage',
      paragraphs: [
        'The portal keeps your session, your language and your theme in your browser’s storage so that you stay signed in and see the portal the way you chose. Product analytics uses an identifier to count which screens are used. There are no advertising cookies.',
      ],
    },
    {
      heading: 'Changes to this policy',
      paragraphs: [
        'When this policy changes, we will ask you to read and accept the new version the next time you sign in, and the version date at the top of this page will change.',
      ],
    },
  ],
};
