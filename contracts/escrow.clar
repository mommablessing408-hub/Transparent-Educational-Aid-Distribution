;; escrow.clar
;; Escrow Smart Contract for Transparent Educational Aid Distribution
;; This contract handles the secure holding and release of funds and resources
;; for educational aid, ensuring conditions are met before distribution.
;; It integrates with other contracts like Verification and DistributionRecord.

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INVALID-AMOUNT u101)
(define-constant ERR-INVALID-RECIPIENT u102)
(define-constant ERR-ESCROW-NOT-FOUND u103)
(define-constant ERR-ESCROW-ACTIVE u104)
(define-constant ERR-ESCROW-EXPIRED u105)
(define-constant ERR-CONDITIONS-NOT-MET u106)
(define-constant ERR-ALREADY-RELEASED u107)
(define-constant ERR-PAUSED u108)
(define-constant ERR-INVALID-DURATION u109)
(define-constant ERR-INVALID-CONDITION u110)
(define-constant ERR-MAX-CONDITIONS-EXCEEDED u111)
(define-constant ERR-INVALID-REFUND u112)
(define-constant ERR-NO-FUNDS u113)
(define-constant ERR-INSUFFICIENT-BALANCE u114)
(define-constant ERR-INVALID-METADATA u115)
(define-constant MAX-CONDITIONS u5)
(define-constant MAX-METADATA-LEN u500)
(define-constant CONTRACT-OWNER tx-sender)

;; Data Variables
(define-data-var contract-paused bool false)
(define-data-var admin principal tx-sender)
(define-data-var total-escrows uint u0)
(define-data-var total-released uint u0)
(define-data-var total-refunded uint u0)

;; Data Maps
(define-map escrows
  { escrow-id: uint }
  {
    donor: principal,
    recipient: principal,
    amount: uint,
    release-conditions: (list 5 (string-utf8 100)), ;; e.g., "verified-enrollment", "proof-of-delivery"
    metadata: (string-utf8 500), ;; Additional details about the aid
    creation-time: uint,
    expiry-time: uint,
    released: bool,
    refunded: bool
  }
)

(define-map escrow-balances
  { escrow-id: uint }
  uint
)

(define-map condition-verifiers
  { condition: (string-utf8 100) }
  principal ;; Verifier principal for each condition type
)

(define-map escrow-fulfillments
  { escrow-id: uint, condition: (string-utf8 100) }
  bool
)

(define-map escrow-auditors
  { escrow-id: uint }
  (list 3 principal) ;; Up to 3 auditors per escrow
)

;; Private Functions
(define-private (is-admin (caller principal))
  (is-eq caller (var-get admin))
)

(define-private (check-conditions-met (escrow-id uint))
  (let
    (
      (escrow (unwrap! (map-get? escrows {escrow-id: escrow-id}) (err ERR-ESCROW-NOT-FOUND)))
      (conditions (get release-conditions escrow))
    )
    (fold check-condition conditions {escrow-id: escrow-id, all-met: true})
  )
)

(define-private (check-condition (condition (string-utf8 100)) (state {escrow-id: uint, all-met: bool}))
  (let
    (
      (escrow-id (get escrow-id state))
      (fulfilled (default-to false (map-get? escrow-fulfillments {escrow-id: escrow-id, condition: condition})))
    )
    {
      escrow-id: escrow-id,
      all-met: (and (get all-met state) fulfilled)
    }
  )
)

(define-private (transfer-stx (amount uint) (recipient principal))
  (as-contract (stx-transfer? amount tx-sender recipient))
)

;; Public Functions
(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (is-admin tx-sender) (err ERR-UNAUTHORIZED))
    (ok (var-set admin new-admin))
  )
)

(define-public (pause-contract)
  (begin
    (asserts! (is-admin tx-sender) (err ERR-UNAUTHORIZED))
    (ok (var-set contract-paused true))
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-admin tx-sender) (err ERR-UNAUTHORIZED))
    (ok (var-set contract-paused false))
  )
)

(define-public (add-condition-verifier (condition (string-utf8 100)) (verifier principal))
  (begin
    (asserts! (is-admin tx-sender) (err ERR-UNAUTHORIZED))
    (ok (map-set condition-verifiers {condition: condition} verifier))
  )
)

(define-public (create-escrow
  (recipient principal)
  (amount uint)
  (conditions (list 5 (string-utf8 100)))
  (metadata (string-utf8 500))
  (duration uint)
  (auditors (list 3 principal)))
  (begin
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (asserts! (not (is-eq recipient tx-sender)) (err ERR-INVALID-RECIPIENT))
    (asserts! (<= (len conditions) MAX-CONDITIONS) (err ERR-MAX-CONDITIONS-EXCEEDED))
    (asserts! (<= (len metadata) MAX-METADATA-LEN) (err ERR-INVALID-METADATA))
    (asserts! (> duration u0) (err ERR-INVALID-DURATION))
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    (let
      (
        (escrow-id (+ (var-get total-escrows) u1))
        (creation-time block-height)
        (expiry-time (+ creation-time duration))
      )
      (map-set escrows
        {escrow-id: escrow-id}
        {
          donor: tx-sender,
          recipient: recipient,
          amount: amount,
          release-conditions: conditions,
          metadata: metadata,
          creation-time: creation-time,
          expiry-time: expiry-time,
          released: false,
          refunded: false
        }
      )
      (map-set escrow-balances {escrow-id: escrow-id} amount)
      (map-set escrow-auditors {escrow-id: escrow-id} auditors)
      (var-set total-escrows escrow-id)
      (ok escrow-id)
    )
  )
)

(define-public (fulfill-condition (escrow-id uint) (condition (string-utf8 100)))
  (let
    (
      (escrow (unwrap! (map-get? escrows {escrow-id: escrow-id}) (err ERR-ESCROW-NOT-FOUND)))
      (verifier (unwrap! (map-get? condition-verifiers {condition: condition}) (err ERR-INVALID-CONDITION)))
    )
    (asserts! (is-eq tx-sender verifier) (err ERR-UNAUTHORIZED))
    (asserts! (not (get released escrow)) (err ERR-ALREADY-RELEASED))
    (asserts! (not (get refunded escrow)) (err ERR-ALREADY-RELEASED))
    (asserts! (> (get expiry-time escrow) block-height) (err ERR-ESCROW-EXPIRED))
    (map-set escrow-fulfillments {escrow-id: escrow-id, condition: condition} true)
    (ok true)
  )
)

(define-public (release-funds (escrow-id uint))
  (let
    (
      (escrow (unwrap! (map-get? escrows {escrow-id: escrow-id}) (err ERR-ESCROW-NOT-FOUND)))
      (balance (unwrap! (map-get? escrow-balances {escrow-id: escrow-id}) (err ERR-NO-FUNDS)))
      (conditions-met (unwrap! (check-conditions-met escrow-id) (err ERR-CONDITIONS-NOT-MET)))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (or (is-eq tx-sender (get recipient escrow)) (is-admin tx-sender)) (err ERR-UNAUTHORIZED))
    (asserts! (not (get released escrow)) (err ERR-ALREADY-RELEASED))
    (asserts! (not (get refunded escrow)) (err ERR-ALREADY-RELEASED))
    (asserts! (> (get expiry-time escrow) block-height) (err ERR-ESCROW-EXPIRED))
    (asserts! (get all-met conditions-met) (err ERR-CONDITIONS-NOT-MET))
    (try! (as-contract (transfer-stx balance (get recipient escrow))))
    (map-set escrows {escrow-id: escrow-id} (merge escrow {released: true}))
    (map-delete escrow-balances {escrow-id: escrow-id})
    (var-set total-released (+ (var-get total-released) balance))
    (ok true)
  )
)

(define-public (refund-funds (escrow-id uint))
  (let
    (
      (escrow (unwrap! (map-get? escrows {escrow-id: escrow-id}) (err ERR-ESCROW-NOT-FOUND)))
      (balance (unwrap! (map-get? escrow-balances {escrow-id: escrow-id}) (err ERR-NO-FUNDS)))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (is-eq tx-sender (get donor escrow)) (err ERR-UNAUTHORIZED))
    (asserts! (not (get released escrow)) (err ERR-ALREADY-RELEASED))
    (asserts! (not (get refunded escrow)) (err ERR-ALREADY-RELEASED))
    (asserts! (<= (get expiry-time escrow) block-height) (err ERR-ESCROW-ACTIVE))
    (try! (as-contract (transfer-stx balance (get donor escrow))))
    (map-set escrows {escrow-id: escrow-id} (merge escrow {refunded: true}))
    (map-delete escrow-balances {escrow-id: escrow-id})
    (var-set total-refunded (+ (var-get total-refunded) balance))
    (ok true)
  )
)

(define-public (add-auditor (escrow-id uint) (auditor principal))
  (let
    (
      (escrow (unwrap! (map-get? escrows {escrow-id: escrow-id}) (err ERR-ESCROW-NOT-FOUND)))
      (current-auditors (unwrap! (map-get? escrow-auditors {escrow-id: escrow-id}) (err ERR-ESCROW-NOT-FOUND)))
    )
    (asserts! (is-eq tx-sender (get donor escrow)) (err ERR-UNAUTHORIZED))
    (asserts! (< (len current-auditors) u3) (err ERR-MAX-CONDITIONS-EXCEEDED))
    (map-set escrow-auditors {escrow-id: escrow-id} (append current-auditors auditor))
    (ok true)
  )
)

;; Read-Only Functions
(define-read-only (get-escrow-details (escrow-id uint))
  (map-get? escrows {escrow-id: escrow-id})
)

(define-read-only (get-escrow-balance (escrow-id uint))
  (map-get? escrow-balances {escrow-id: escrow-id})
)

(define-read-only (is-condition-fulfilled (escrow-id uint) (condition (string-utf8 100)))
  (map-get? escrow-fulfillments {escrow-id: escrow-id, condition: condition})
)

(define-read-only (get-condition-verifier (condition (string-utf8 100)))
  (map-get? condition-verifiers {condition: condition})
)

(define-read-only (get-total-escrows)
  (var-get total-escrows)
)

(define-read-only (get-total-released)
  (var-get total-released)
)

(define-read-only (get-total-refunded)
  (var-get total-refunded)
)

(define-read-only (is-contract-paused)
  (var-get contract-paused)
)

(define-read-only (get-admin)
  (var-get admin)
)

(define-read-only (get-escrow-auditors (escrow-id uint))
  (map-get? escrow-auditors {escrow-id: escrow-id})
)