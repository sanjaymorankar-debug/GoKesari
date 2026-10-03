"use client";

import { useState, useRef, useEffect } from "react";

interface ProfileCompletionFormProps {
  onComplete: (data: any) => Promise<void>;
  onSkip: () => Promise<void>;
}

const inputClass =
  "min-w-0 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none";
const buttonClass =
  "rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-700 disabled:opacity-50";

export function ProfileCompletionForm({ onComplete, onSkip }: ProfileCompletionFormProps) {
  const [step, setStep] = useState<"personal" | "address">("personal");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useGeolocation, setUseGeolocation] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);

  // Personal details
  const [name, setName] = useState("");
  const [gender, setGender] = useState<string>("");
  const [mobileNumber, setMobileNumber] = useState("");

  // Address details
  const [addressLabel, setAddressLabel] = useState("Home");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [area, setArea] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [pincode, setPincode] = useState("");
  const [latitude, setLatitude] = useState<string>("");
  const [longitude, setLongitude] = useState<string>("");
  const [landmark, setLandmark] = useState("");

  const handleUseLocation = () => {
    setLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(String(position.coords.latitude));
        setLongitude(String(position.coords.longitude));
        setUseGeolocation(true);
        setLoading(false);
      },
      (err) => {
        setError("Could not access your location. Please enter address manually.");
        setLoading(false);
      }
    );
  };

  const handlePersonalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    setStep("address");
  };

  const handleAddressSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const data = {
        name,
        ...(gender && { gender }),
        ...(mobileNumber && { mobileNumber }),
        ...(line1 && {
          deliveryAddress: {
            label: addressLabel,
            line1,
            line2,
            area,
            city,
            state,
            pincode,
            latitude,
            longitude,
            landmark,
          },
        }),
      };

      await onComplete(data);
      // Redirect happens after successful submission
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = async () => {
    setLoading(true);
    try {
      await onSkip();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to skip profile");
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-cream-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-ink-900 mb-6">
        {step === "personal" ? "Tell us about yourself" : "Add delivery address"}
      </h2>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-900">{error}</p>
        </div>
      )}

      {step === "personal" && (
        <form onSubmit={handlePersonalSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Full Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your full name"
              className={inputClass}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Gender
            </label>
            <select value={gender} onChange={(e) => setGender(e.target.value)} className={inputClass}>
              <option value="">Prefer not to say</option>
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
              <option value="OTHER">Other</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Mobile Number (for faster login)
            </label>
            <input
              type="tel"
              value={mobileNumber}
              onChange={(e) => setMobileNumber(e.target.value.replace(/\D/g, ""))}
              placeholder="10-digit mobile number"
              className={inputClass}
              maxLength={10}
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSkip}
              disabled={loading}
              className="flex-1 rounded-lg border border-cream-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100"
            >
              Fill in later
            </button>
            <button type="submit" disabled={loading} className={`flex-1 ${buttonClass}`}>
              {loading ? "..." : "Next"}
            </button>
          </div>
        </form>
      )}

      {step === "address" && (
        <form onSubmit={handleAddressSubmit} className="space-y-4">
          <button
            type="button"
            onClick={handleUseLocation}
            disabled={loading}
            className="mb-4 w-full rounded-lg border border-kesari-200 bg-kesari-50 px-4 py-2 text-sm font-medium text-kesari-700 hover:bg-kesari-100"
          >
            {loading ? "Detecting location..." : "📍 Use my current location"}
          </button>

          {useGeolocation && latitude && longitude && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
              Location detected: {latitude.substring(0, 9)}°, {longitude.substring(0, 9)}°
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Address Label
            </label>
            <input
              type="text"
              value={addressLabel}
              onChange={(e) => setAddressLabel(e.target.value)}
              placeholder="e.g. Home, Office"
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Street Address *
            </label>
            <input
              type="text"
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              placeholder="Street address"
              className={inputClass}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Apartment / Building (optional)
            </label>
            <input
              type="text"
              value={line2}
              onChange={(e) => setLine2(e.target.value)}
              placeholder="Apartment, suite, etc."
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1">
                Area (optional)
              </label>
              <input
                type="text"
                value={area}
                onChange={(e) => setArea(e.target.value)}
                placeholder="Area / Locality"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1">
                City *
              </label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="City"
                className={inputClass}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1">
                State (optional)
              </label>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                placeholder="State"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1">
                Postal Code *
              </label>
              <input
                type="text"
                value={pincode}
                onChange={(e) => setPincode(e.target.value.replace(/\D/g, ""))}
                placeholder="Postal code"
                className={inputClass}
                maxLength={10}
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Landmark (optional)
            </label>
            <input
              type="text"
              value={landmark}
              onChange={(e) => setLandmark(e.target.value)}
              placeholder="Nearby landmark"
              className={inputClass}
            />
          </div>

          <div className="flex gap-2 pt-4">
            <button
              type="button"
              onClick={() => setStep("personal")}
              disabled={loading}
              className="flex-1 rounded-lg border border-cream-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100"
            >
              Back
            </button>
            <button
              type="button"
              onClick={handleSkip}
              disabled={loading}
              className="flex-1 rounded-lg border border-cream-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100"
            >
              Skip address
            </button>
            <button type="submit" disabled={loading || !line1 || !city || !pincode} className={`flex-1 ${buttonClass}`}>
              {loading ? "..." : "Complete"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
