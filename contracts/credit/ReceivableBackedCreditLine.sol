// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {IERC721, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Credit} from "./Credit.sol";
import {CreditRecord, CreditState, DueDetail, ReceivableInfo} from "./CreditStructs.sol";
import {Errors} from "../common/Errors.sol";
import {IReceivableBackedCreditLineManager} from "./interfaces/IReceivableBackedCreditLineManager.sol";
import {IReceivable} from "./interfaces/IReceivable.sol";

contract ReceivableBackedCreditLine is Credit, IERC721Receiver {
    /**
     * @notice A principal payment has been made against the credit line.
     * @param borrower The address of the borrower.
     * @param receivableId The ID of the receivable.
     * @param amount The payback amount.
     * @param by The address that initiated the principal payment.
     */
    event PrincipalPaymentMadeWithReceivable(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 amount,
        address by
    );

    /**
     * @notice A payment has been made against the credit line.
     * @param borrower The address of the borrower.
     * @param receivableId The ID of the receivable.
     * @param amount The payback amount.
     * @param by The address that initiated the payment.
     */
    event PaymentMadeWithReceivable(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 amount,
        address by
    );

    /**
     * @notice A borrowing event has happened to the credit line.
     * @param borrower The address of the borrower.
     * @param receivableId The ID of the receivable.
     * @param amount The payback amount.
     * @param by The address that initiated the payment.
     */
    event DrawdownMadeWithReceivable(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 amount,
        address by
    );

    function onERC721Received(
        address /*operator*/,
        address /*from*/,
        uint256 /*tokenId*/,
        bytes calldata /*data*/
    ) external virtual returns (bytes4) {
        poolConfig.onlyProtocolAndPoolOn();
        return this.onERC721Received.selector;
    }

    function getNextBillRefreshDate(address borrower) external view returns (uint256 refreshDate) {
        bytes32 creditHash = getCreditHash(borrower);
        return _getNextBillRefreshDate(creditHash);
    }

    function getDueInfo(
        address borrower
    ) external view returns (CreditRecord memory cr, DueDetail memory dd) {
        bytes32 creditHash = getCreditHash(borrower);
        return _getDueInfo(creditHash);
    }

    /**
     * @notice Allows the borrower to drawdown using a receivable.
     */
    function drawdownWithReceivable(
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 netAmountToBorrower) {
        poolConfig.onlyProtocolAndPoolOn();

        bytes32 creditHash = getCreditHash(msg.sender);
        creditManager.onlyCreditBorrower(creditHash, msg.sender);

        _prepareForDrawdown(
            msg.sender,
            creditHash,
            poolConfig.receivableAsset(),
            receivableId,
            amount
        );
        netAmountToBorrower = _drawdown(msg.sender, creditHash, amount);

        emit DrawdownMadeWithReceivable(msg.sender, receivableId, amount, msg.sender);
    }

    /**
     * @notice Allows the borrower to payback and label it with a receivable
     */
    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) _onlySentinelServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        _prepareForPayment(borrower, poolConfig.receivableAsset(), receivableId);

        (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);

        emit PaymentMadeWithReceivable(borrower, receivableId, amount, msg.sender);
    }

    /**
     * @notice Allows the borrower to payback the principal and label it with a receivable
     */
    function makePrincipalPaymentWithReceivable(
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();

        bytes32 creditHash = getCreditHash(msg.sender);
        creditManager.onlyCreditBorrower(creditHash, msg.sender);

        _prepareForPayment(msg.sender, poolConfig.receivableAsset(), receivableId);

        (amountPaid, paidoff) = _makePrincipalPayment(msg.sender, creditHash, amount);

        emit PrincipalPaymentMadeWithReceivable(msg.sender, receivableId, amount, msg.sender);
    }

    /**
     * @notice Allows the borrower to payback the principal with a receivable and drawdown at the same time with
     * another receivable
     */
    function makePrincipalPaymentAndDrawdownWithReceivable(
        uint256 paymentReceivableId,
        uint256 paymentAmount,
        uint256 drawdownReceivableId,
        uint256 drawdownAmount
    ) public virtual returns (uint256 amountPaid, uint256 netAmountToBorrower, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();

        bytes32 creditHash = getCreditHash(msg.sender);
        creditManager.onlyCreditBorrower(creditHash, msg.sender);
        CreditRecord memory cr = getCreditRecord(creditHash);
        if (cr.state != CreditState.GoodStanding)
            revert Errors.CreditNotInStateForMakingPrincipalPayment();

        if (drawdownAmount == 0 || paymentAmount == 0) revert Errors.ZeroAmountProvided();

        uint256 principalOutstanding = cr.unbilledPrincipal + cr.nextDue - cr.yieldDue;
        if (principalOutstanding == 0) {
            // No principal payment is needed when there is no principal outstanding.
            return (0, 0, false);
        }

        address receivableAsset = poolConfig.receivableAsset();
        _prepareForPayment(msg.sender, receivableAsset, paymentReceivableId);
        _prepareForDrawdown(
            msg.sender,
            creditHash,
            receivableAsset,
            drawdownReceivableId,
            drawdownAmount
        );

        if (paymentAmount == drawdownAmount) {
            // When the payment and drawdown amounts are the same, calling `makePaymentWithReceivable()`
            // and then `drawdownWithReceivable()` would cause additional yield to be incurred, which is not
            // desired. Instead, we deposit and then withdraw from the `poolSafe` to show that the pool has
            // received payment and then disbursed the same amount back to the borrower.
            poolSafe.deposit(msg.sender, paymentAmount);
            poolSafe.withdraw(msg.sender, paymentAmount);
        } else if (paymentAmount > drawdownAmount) {
            uint256 amount = paymentAmount - drawdownAmount;
            (amountPaid, paidoff) = _makePrincipalPayment(msg.sender, creditHash, amount);
            poolSafe.deposit(msg.sender, drawdownAmount);
            poolSafe.withdraw(msg.sender, drawdownAmount);
        } else {
            // paymentAmount < drawdownAmount
            uint256 amount = drawdownAmount - paymentAmount;
            netAmountToBorrower = _drawdown(msg.sender, creditHash, amount);
            poolSafe.deposit(msg.sender, paymentAmount);
            poolSafe.withdraw(msg.sender, paymentAmount);
        }

        emit PrincipalPaymentMadeWithReceivable(
            msg.sender,
            paymentReceivableId,
            paymentAmount,
            msg.sender
        );

        emit DrawdownMadeWithReceivable(
            msg.sender,
            drawdownReceivableId,
            drawdownAmount,
            msg.sender
        );
    }

    function getCreditHash(address borrower) public view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }

    function _prepareForDrawdown(
        address borrower,
        bytes32 creditHash,
        address receivableAsset,
        uint256 receivableId,
        uint256 amount
    ) internal {
        if (receivableId == 0) revert Errors.ZeroReceivableIdProvided();
        ReceivableInfo memory receivable = IReceivable(receivableAsset).getReceivable(
            receivableId
        );
        if (amount > receivable.receivableAmount) revert Errors.InsufficientReceivableAmount();
        if (IERC721(receivableAsset).ownerOf(receivableId) != borrower)
            revert Errors.ReceivableOwnerRequired();

        IReceivableBackedCreditLineManager rbclManager = IReceivableBackedCreditLineManager(
            address(creditManager)
        );
        if (_getCreditConfig(creditHash).receivableAutoApproval) {
            rbclManager.approveReceivable(borrower, receivableId);
        } else {
            rbclManager.validateReceivableOwnership(borrower, receivableId);
            rbclManager.validateReceivableStatus(receivable.maturityDate, receivable.state);
        }
        rbclManager.decreaseAvailableCredit(creditHash, amount);

        IERC721(receivableAsset).safeTransferFrom(borrower, address(this), receivableId);
    }

    function _prepareForPayment(
        address borrower,
        address receivableAsset,
        uint256 receivableId
    ) internal view {
        if (receivableId == 0) revert Errors.ZeroReceivableIdProvided();
        IReceivableBackedCreditLineManager(address(creditManager)).validateReceivableOwnership(
            borrower,
            receivableId
        );
        if (IERC721(receivableAsset).ownerOf(receivableId) != address(this))
            revert Errors.ReceivableOwnerRequired();
    }
}
