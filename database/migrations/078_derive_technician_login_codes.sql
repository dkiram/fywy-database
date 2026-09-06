-- Technician codes are now made from the technician's name.
--
-- Migration 075 issued six random characters - ABC234 - from an alphabet with
-- the confusable letters removed. It was unguessable, which is a virtue it did
-- not need: the code only says WHO is signing in, and the six-digit passcode
-- is the half that proves it. What it actually had to be was easy to read off
-- a card, easy to say over a radio, and obviously yours. Random characters are
-- none of those, and a technician who mislays the card cannot reconstruct it.
--
-- A code is now the first letter of the first name and the first five letters
-- of the last name: Andre Clarke signs in as ACLARK. Where two people would
-- produce the same code, later ones take a digit - ACLARK2, ACLARK3 - so the
-- length runs from two to seven rather than always six.
--
-- The passcode is deliberately NOT derived from anything. It stays six random
-- digits, because a credential whose halves can both be worked out from a name
-- badge is not a credential.
--
-- The old format stays legal, so codes issued before today keep working
-- unchanged rather than locking somebody out of a phone that was fine
-- yesterday.

ALTER TABLE public.technician_phone_access
    DROP CONSTRAINT IF EXISTS technician_phone_access_login_code_check;

ALTER TABLE public.technician_phone_access
    ADD CONSTRAINT technician_phone_access_login_code_check
    CHECK (
        -- Derived from a name: initial, up to five letters of the surname,
        -- and an optional digit that separates two people who collide. The
        -- digit starts at 2 - the first Clarke is simply ACLARK - and 0 and 1
        -- stay out of it entirely so they cannot be misread as O and I.
        login_code ~ '^[A-Z]{2,6}[2-9]?$'

        -- Issued before this migration, by migration 075.
        OR login_code ~ '^[A-HJ-NP-RT-Z2-9]{6}$'
    );
