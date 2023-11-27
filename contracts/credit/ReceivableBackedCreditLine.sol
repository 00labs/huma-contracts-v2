// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

// import {IERC721, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
// import {BorrowerLevelCreditConfig} from "./BorrowerLevelCreditConfig.sol";
// import {ReceivableInput} from "./CreditStructs.sol";
// import {ReceivableBackedCreditLineStorage} from "./ReceivableBackedCreditLineStorage.sol";
// import {CreditConfig, CreditRecord, CreditLimit, PayPeriodDuration, CreditState} from "./CreditStructs.sol";
// import {Errors} from "../Errors.sol";

// contract ReceivableBackedCreditLine is
//     BorrowerLevelCreditConfig,
//     ReceivableBackedCreditLineStorage,
//     IERC721Receiver
// {
//     event ReceivableApproved(
//         address borrower,
//         uint256 receivableId,
//         uint256 receivableAmount,
//         uint256 incrementalCredit,
//         uint256 availableCredit
//     );

//     event PrincipalPaymentWithReceivableMade(
//         address indexed borrower,
//         uint256 indexed receivableId,
//         uint256 amount,
//         address by
//     );

//     event PaymentWithReceivableMade(
//         address indexed borrower,
//         uint256 indexed receivableId,
//         uint256 amount,
//         address by
//     );

//     event DrawdownWithReceivableMade(
//         address indexed borrower,
//         uint256 indexed receivableId,
//         uint256 receivableAmount,
//         uint256 amount,
//         address by
//     );

//     /**
//      * @notice Approves a receivable, adjusts availableCredit by applying advantce ratio
//      * @dev Only when the protocol and pool are live.
//      * @dev only EA service account can call this function
//      */
//     function approveReceivable(address borrower, ReceivableInput memory receivableInput) external {
//         poolConfig.onlyProtocolAndPoolOn();
//         _onlyEAServiceAccount();

//         if (receivableInput.receivableAmount == 0) revert Errors.zeroAmountProvided();
//         if (receivableInput.receivableId == 0) revert Errors.zeroReceivableIdProvided();

//         bytes32 creditHash = getCreditHash(borrower);
//         if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();

//         _approveReceivable(borrower, creditHash, receivableInput);
//     }

//     function _approveReceivable(
//         address borrower,
//         bytes32 creditHash,
//         ReceivableInput memory receivableInput
//     ) internal {
//         uint256 incrementalCredit = getCreditConfig(creditHash).advanceRateInBps *
//             receivableInput.receivableAmount;
//         CreditLimit memory cl = getCreditLimit(creditHash);
//         cl.availableCredit += uint96(incrementalCredit);
//         _setCreditLimit(creditHash, cl);

//         receivableBorrowerMap[receivableInput.receivableId] = borrower;

//         emit ReceivableApproved(
//             borrower,
//             receivableInput.receivableId,
//             receivableInput.receivableAmount,
//             incrementalCredit,
//             cl.availableCredit
//         );
//     }

//     /**
//      * @notice Allows the borrower to drawdown using a receivable.
//      */
//     function drawdownWithReceivable(
//         address borrower,
//         ReceivableInput memory receivableInput,
//         uint256 amount
//     ) public virtual {
//         poolConfig.onlyProtocolAndPoolOn();
//         if (msg.sender != borrower) revert Errors.notBorrower();

//         bytes32 creditHash = getCreditHash(borrower);
//         if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();

//         _prepareForDrawdown(
//             borrower,
//             creditHash,
//             IERC721(poolConfig.receivableAsset()),
//             receivableInput,
//             amount
//         );
//         _drawdown(borrower, creditHash, amount);

//         emit DrawdownWithReceivableMade(
//             borrower,
//             receivableInput.receivableId,
//             receivableInput.receivableAmount,
//             amount,
//             msg.sender
//         );
//     }

//     /**
//      * @notice Allows the borrower to payback and label it with a receivable
//      */
//     function makePaymentWithReceivable(
//         address borrower,
//         uint256 receivableId,
//         uint256 amount
//     ) public virtual returns (uint256 amountPaid, bool paidoff) {
//         poolConfig.onlyProtocolAndPoolOn();
//         if (msg.sender != borrower) _onlyPDSServiceAccount();

//         bytes32 creditHash = getCreditHash(borrower);
//         if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();

//         if (receivableId > 0) {
//             _prepareForPayment(borrower, IERC721(poolConfig.receivableAsset()), receivableId);
//             // todo update the receivable to indicate it is paid.
//         }

//         (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);

//         emit PaymentWithReceivableMade(borrower, receivableId, amount, msg.sender);
//     }

//     /**
//      * @notice Allows the borrower to payback and label it with a receivable
//      */
//     function makePrincipalPaymentWithReceivable(
//         address borrower,
//         uint256 receivableId,
//         uint256 amount
//     ) public virtual returns (uint256 amountPaid, bool paidoff) {
//         poolConfig.onlyProtocolAndPoolOn();
//         if (msg.sender != borrower) revert Errors.notBorrower();

//         bytes32 creditHash = getCreditHash(borrower);
//         if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();

//         IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
//         _prepareForPayment(borrower, receivableAsset, receivableId);

//         (amountPaid, paidoff) = _makePrincipalPayment(borrower, creditHash, amount);

//         emit PrincipalPaymentWithReceivableMade(borrower, receivableId, amount, msg.sender);
//     }

//     /**
//      * @notice Allows the borrower to payback and label it with a receivable
//      */
//     function makePrincipalPaymentAndDrawdownWithReceivable(
//         address borrower,
//         uint256 paymentReceivableId,
//         uint256 paymentAmount,
//         ReceivableInput memory drawdownReceivableInput,
//         uint256 drawdownAmount
//     ) public virtual returns (uint256 amountPaid, bool paidoff) {
//         poolConfig.onlyProtocolAndPoolOn();
//         if (msg.sender != borrower) revert Errors.notBorrower();

//         bytes32 creditHash = getCreditHash(borrower);
//         if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();
//         if (getCreditRecord(creditHash).state != CreditState.GoodStanding)
//             revert Errors.creditNotInStateForDrawdown();

//         IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
//         _prepareForPayment(borrower, receivableAsset, paymentReceivableId);
//         _prepareForDrawdown(
//             borrower,
//             creditHash,
//             receivableAsset,
//             drawdownReceivableInput,
//             drawdownAmount
//         );

//         if (paymentAmount == drawdownAmount) {
//             poolSafe.deposit(msg.sender, paymentAmount);
//             poolSafe.withdraw(borrower, paymentAmount);
//         } else if (paymentAmount > drawdownAmount) {
//             poolSafe.deposit(msg.sender, drawdownAmount);
//             poolSafe.withdraw(borrower, drawdownAmount);

//             uint256 amount = paymentAmount - drawdownAmount;
//             (amountPaid, paidoff) = _makePrincipalPayment(borrower, creditHash, amount);
//         } else {
//             // paymentAmount < drawdownAmount
//             poolSafe.deposit(msg.sender, paymentAmount);
//             poolSafe.withdraw(borrower, paymentAmount);
//             uint256 amount = drawdownAmount - paymentAmount;
//             _drawdown(borrower, creditHash, amount);
//         }

//         emit PrincipalPaymentWithReceivableMade(
//             borrower,
//             paymentReceivableId,
//             paymentAmount,
//             msg.sender
//         );

//         emit DrawdownWithReceivableMade(
//             borrower,
//             drawdownReceivableInput.receivableId,
//             drawdownReceivableInput.receivableAmount,
//             drawdownAmount,
//             msg.sender
//         );
//     }

//     function onERC721Received(
//         address /*operator*/,
//         address /*from*/,
//         uint256 /*tokenId*/,
//         bytes calldata /*data*/
//     ) external virtual returns (bytes4) {
//         return this.onERC721Received.selector;
//     }

//     function _prepareForPayment(
//         address borrower,
//         IERC721 receivableAsset,
//         uint256 receivableId
//     ) internal view {
//         if (receivableId == 0) revert Errors.zeroReceivableIdProvided();
//         if (receivableBorrowerMap[receivableId] != borrower) revert Errors.receivableIdMismatch();
//         if (receivableAsset.ownerOf(receivableId) != address(this)) revert Errors.todo();
//     }

//     function _prepareForDrawdown(
//         address borrower,
//         bytes32 creditHash,
//         IERC721 receivableAsset,
//         ReceivableInput memory receivableInput,
//         uint256 amount
//     ) internal {
//         if (receivableInput.receivableAmount == 0) revert Errors.zeroAmountProvided();
//         if (receivableInput.receivableId == 0) revert Errors.zeroReceivableIdProvided();
//         if (amount == 0) revert Errors.zeroAmountProvided();
//         if (receivableAsset.ownerOf(receivableInput.receivableId) != borrower)
//             revert Errors.todo();

//         if (getCreditConfig(creditHash).autoApproval) {
//             _approveReceivable(borrower, creditHash, receivableInput);
//         } else {
//             if (receivableBorrowerMap[receivableInput.receivableId] != borrower)
//                 revert Errors.receivableIdMismatch();
//         }

//         CreditLimit memory cl = getCreditLimit(creditHash);
//         if (amount > cl.availableCredit) revert Errors.todo();

//         cl.availableCredit -= uint96(amount);
//         _setCreditLimit(creditHash, cl);

//         receivableAsset.safeTransferFrom(borrower, address(this), receivableInput.receivableId);
//     }
// }
