// "Add tool" — the five-step install wizard.
// SKELETON — see docs/notes/mcp-plugin-system-tasks.md task T20 and the plan's
// "The Add tool flow" / "Generating step 2 from metadata".
//
// The admin never types a shell command. Redstart runs the install itself.

import { useState } from 'react'

/** One generated input. Registry metadata maps onto this directly:
 *  name -> label, description -> helper text, format -> widget,
 *  isRequired -> asterisk + submit block, default -> value, placeholder -> hint. */
export type FormField = {
  name: string
  description?: string
  format: 'string' | 'filepath' | 'boolean'
  isRequired: boolean
  isSecret: boolean
  default?: string
  placeholder?: string
}

export type WizardStep = 1 | 2 | 3 | 4 | 5

type Props = {
  open: boolean
  onClose: () => void
}

/**
 * TODO(T20): mask a field even when the publisher forgot to flag it.
 *
 * ####################################################################
 * # isSecret is publisher-set and present on only about a third of    #
 * # declarations in the wild. Treat a field as secret when isSecret   #
 * # is true OR its NAME looks like a credential.                      #
 * #                                                                   #
 * # Over-masking costs one annoyance. Under-masking puts a live key   #
 * # in a plaintext box AND outside the encrypted storage path, because #
 * # this function is what decides which values get encrypted (D-f).   #
 * ####################################################################
 */
export const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

export function isSecretField(field: FormField): boolean {
  return field.isSecret || SECRET_NAME_PATTERN.test(field.name)
}

export function AddToolDialog(_props: Props) {
  const [step, setStep] = useState<WizardStep>(1)

  // TODO(T20): the five steps.
  //
  //  1 SOURCE   — Browse registry / npm package + version / local folder /
  //               advanced (raw command). Registry results show their verdict;
  //               unsupported ones are shown WITH a reason, never hidden.
  //
  //  2 SETTINGS — Generated from registry metadata when available, free-form
  //               name/value rows otherwise. Rows, with add-another: one real
  //               entry needs five separate credentials, so a single field is
  //               wrong. Secret rows use a masked input (isSecretField above).
  //               format 'filepath' uses the same folder picker as the
  //               capability cards — granting a path is granting a location on
  //               disk, so step 5 says so.
  //               NO "show current value" control. Ever. Values go out once.
  //
  //  3 INSTALL  — progress bar fed by onPluginInstallProgress. Failures show
  //               the specific cause from the install/probe taxonomy, never an
  //               indefinite spinner. Then verification, which reports WHAT IT
  //               CHECKED: "Connected — N tools. Credentials aren't verified
  //               until first use." Never a bare green tick.
  //
  //  4 CLASSIFY — discovered tools in a table, every one starting at the most
  //               restrictive class. The admin promotes individually.
  //
  //  5 CONFIRM  — plain English, before anything is saved:
  //                 • data and any key are SHARED BY EVERY ACCOUNT on this
  //                   server (D2)
  //                 • plugin code runs with THE SAME OS PERMISSIONS AS NEST
  //                 • when a secret is set, this plugin will be DECLARED AS A
  //                   DATA PATH to users and to the model (D-f)
  //
  // Saved with enabled:false. Enabling is a separate, deliberate act.
  return (
    <div className="p-6 text-sm text-zinc-400">
      <p className="font-medium text-zinc-200">Add tool</p>
      <p className="mt-2">Step {step} — not implemented yet; see TODO(T20).</p>
      <button className="mt-3 underline" onClick={() => setStep(1)}>reset</button>
    </div>
  )
}
