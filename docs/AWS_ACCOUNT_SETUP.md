# AWS Account Setup Guide (MFT Hub)

Do these steps yourself in the browser. The agent never creates accounts or handles passwords, card details, or credentials.

> **About the sign-up credits:** AWS gives $100 (plus up to $100 more for completing activities) to _new_ customers. AWS may withhold credits if it recognises you as an existing customer, for example from the same card, phone, or identity. Check the result in step 10.

---

## Part A — Create the account (~15 min)

**What you need:** an email address that has never been used for AWS, a debit or credit card that can take international payments, and a phone that can receive an SMS or call.

1. Go to <https://signin.aws.amazon.com/signup?request_type=register>.
2. Enter the **root user email** and an **account name** (e.g. `mft-hub-sandbox`). Verify the email with the code AWS sends you.
3. Set a **strong, unique root password**. Store it in a password manager.
4. **Choose a plan → pick _Paid account plan_.**
   - The Free plan only gives access to _select_ services, so AWS Transfer Family may not be available on it.
   - The Free plan **auto-upgrades to Paid** once you enable AWS Organizations, which IAM Identity Center (step 13) needs anyway.
   - On the Free plan, the account **closes automatically** after 6 months or when the credits run out, and resources are deleted after 90 days.
   - The Paid plan still gets the $100 sign-up credit. You only pay for usage beyond your credits, and the budget alarm protects you there.
5. **Contact info:** choose _Personal_ and fill in your real name and address. These must match your card.
6. **Billing:** enter your card. AWS places a small temporary hold (about $1) to verify it.
7. **Identity verification:** confirm by SMS or voice call.
8. **Support plan:** choose **Basic support – Free**.
9. Wait for activation. It's usually a few minutes but can take up to 24 h, and you'll get an email when it's done.

---

## Part B — Secure the account and protect your budget (~15 min)

Sign in as the **root user**.

10. **Check your credits:** Billing and Cost Management → **Credits**. Note the amount and expiry date.
11. **MFA on root:** click your account name (top right) → Security credentials → **Assign MFA device**. Use a passkey or an authenticator app.
    - **Do not create root access keys.**
12. **Enable the Zurich region:** account name → Account → **AWS Regions** → _Europe (Zurich) eu-central-2_ → **Enable**. This takes a few minutes.
13. **Billing alerts:** Billing → **Billing preferences** → turn on _Receive AWS Free Tier alerts_ and _Receive CloudWatch billing alerts_.
14. **Safety budget, created by hand before any infrastructure exists:** Billing → **Budgets** → Create budget → **Use a template** → _Zero spend budget_. Use your email. (The project's CDK will add a $5 budget later.)

---

## Part C — IAM Identity Center so the CLI has no long-lived keys (~15 min)

15. Switch the region selector to **Europe (Zurich)**. If Identity Center isn't offered there, use **Europe (Frankfurt)**.
16. Open **IAM Identity Center** → **Enable** → choose **Enable with AWS Organizations**. This creates an organization in which your account is the management account.
17. **Users → Add user**, for example `ehtisham-admin`. Use your email, then **send an email invitation**.
18. **Permission sets → Create** → _Predefined_ → **AdministratorAccess**. Set the session duration to **4 hours**.
    - For a solo sandbox this is fine. Note it in the journal as "would be least-privilege in production".
19. **AWS accounts** → tick your account → **Assign users or groups** → pick your user → pick the `AdministratorAccess` permission set → Submit.
20. Accept the email invitation: set the user's password and **register MFA**.
21. Back in Identity Center → **Settings/Dashboard**, copy the **AWS access portal URL** (`https://d-xxxxxxxxxx.awsapps.com/start`) and note the **Identity Center region**.
22. From now on, **stop using root** for daily work.

---

## Part D — Hand back to Claude

Tell the agent these two things. They aren't secrets:

- the AWS access portal URL
- the Identity Center region

The agent will then:

- install AWS CLI v2 and the CDK
- have **you** run `aws configure sso`, using profile name `mft-hub` and default region `eu-central-2`, and complete the browser login
- verify with `aws sts get-caller-identity --profile mft-hub`
- run `cdk bootstrap` in `eu-central-2`

---

## Part E — Activate advanced AWS features (needed for Transfer Family + Zurich)

The new account was created with the "new AWS experience". Its AWS-managed policies block Transfer Family and every region except the project region (`eu-north-1`). You do these steps yourself; they change account security settings.

**1. Upgrade to the Paid Plan**

1. Open <https://settings.aws.com>.
2. Find the plan / billing section and choose **Upgrade** to the Paid Plan. Your remaining credits carry over.

**2. Activate advanced features (irreversible)**

1. In AWS Settings → **Projects** → **Actions** → **Explore advanced features**.
2. **Team name:** e.g. `mft-hub`.
3. **Management account email:** use your own email and complete the verification.
4. **Review and complete activation** → **Activate**.
5. Set the **root password** for the management account when prompted, then **enable MFA** on it.

**3. Allow Zurich in the region SCP** (signed in to the **management account**)

1. Open the **AWS Organizations** console → **Policies** → **Service control policies**.
2. Open the AWS-created policy that restricts regions. Find the statement with Sid **`RegionFloor`**.
3. Edit it to add `"eu-central-2"` next to `"eu-north-1"` in the allowed-regions list. Change nothing else, then **Save**.
   - Copy the original policy JSON somewhere first, so you can undo the change.

**4. Enable the Zurich region for the project account**

1. Still in the management account: **AWS Organizations** → **AWS accounts** → select your **project account** (`090243701552`) → **Regions** (or Account → AWS Regions).
2. Select **Europe (Zurich) eu-central-2** → **Enable**. The status goes from _Enabling_ to _Enabled_, which can take several minutes.

**5. Cost guardrail (replaces the removed spend limit)**

- Management account → **Billing and Cost Management → Budgets → Create budget**. Choose a **Monthly cost budget** of **$10**, with email alerts at 50%, 80% and 100% (actual) and 100% (forecasted).
- Optional: **Cost Anomaly Detection** → create a monitor with email alerts.

**6. Tell Claude when you're done.** Claude will then check whether Transfer Family and Zurich are reachable with the `mft-hub` profile.

---

## Old account housekeeping

Your old account's console showed **EC2** under _Recently visited_. Before switching:

- In **AWS Global View**, check that there are no running EC2 instances, unattached EBS volumes, Elastic IPs, NAT gateways or load balancers in _any_ region.
- Check **Billing → Bills** for current-month charges.
- Optionally close the account (Account → Close account) once it's empty.
