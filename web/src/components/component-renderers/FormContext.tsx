"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PropertyValue } from "@/src/module_bindings/types";

export type FormFieldGetter = () => PropertyValue | null;

export type FormContextValue = {
  databaseId: bigint;
  cursorMode: "new" | "single" | "filtered";
  registerField: (propertyDefinitionId: bigint, getter: FormFieldGetter) => () => void;
  /** Triggered by Button action `submit_form` inside this form. */
  requestSubmit: () => void;
  submitting: boolean;
};

const FormContext = createContext<FormContextValue | null>(null);

export function useFormContext(): FormContextValue | null {
  return useContext(FormContext);
}

export function FormContextProvider({
  value,
  children,
}: {
  value: FormContextValue;
  children: ReactNode;
}) {
  return (
    <FormContext.Provider value={value}>{children}</FormContext.Provider>
  );
}

/** Collects field getters registered by child Input blocks. */
export function useFormFieldRegistry() {
  const fieldsRef = useRef(new Map<bigint, FormFieldGetter>());

  const registerField = useCallback(
    (propertyDefinitionId: bigint, getter: FormFieldGetter) => {
      fieldsRef.current.set(propertyDefinitionId, getter);
      return () => {
        fieldsRef.current.delete(propertyDefinitionId);
      };
    },
    [],
  );

  const collectValues = useCallback((): Map<bigint, PropertyValue> => {
    const out = new Map<bigint, PropertyValue>();
    for (const [propId, getter] of fieldsRef.current) {
      const v = getter();
      if (v != null) out.set(propId, v);
    }
    return out;
  }, []);

  return useMemo(
    () => ({ registerField, collectValues }),
    [registerField, collectValues],
  );
}

/** Simple submit status for form chrome. */
export function useFormSubmitState() {
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return { submitting, setSubmitting, message, setMessage };
}
