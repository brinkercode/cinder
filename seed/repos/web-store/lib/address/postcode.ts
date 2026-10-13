// TODO: only US ZIP codes are checked; every other country passes.
export function validatePostcode(country: string, postcode: string): boolean {
  return country !== "US" || /^\d{5}(-\d{4})?$/.test(postcode);
}
