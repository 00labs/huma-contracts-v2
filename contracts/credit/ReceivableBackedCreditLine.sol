// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC721, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Credit} from "./Credit.sol";
import {CreditRecord, CreditState, DueDetail, ReceivableInfo} from "./CreditStructs.sol";
import {Errors} from "../common/Errors.sol";
import {IReceivableBackedCreditLineManager} from "./interfaces/IReceivableBackedCreditLineManager.sol";
import {IReceivable} from "./interfaces/IReceivable.sol";

contract ReceivableBackedCreditLine is Credit, IERC721Receiver {
    event PrincipalPaymentMadeWithReceivable(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 amount,
        address by
    );

    event PaymentMadeWithReceivable(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 amount,
        address by
    );

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
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 netAmountToBorrower) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) revert Errors.BorrowerRequired();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        _prepareForDrawdown(
            borrower,
            creditHash,
            poolConfig.receivableAsset(),
            receivableId,
            amount
        );
        netAmountToBorrower = _drawdown(borrower, creditHash, amount);

        emit DrawdownMadeWithReceivable(borrower, receivableId, amount, msg.sender);
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
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) revert Errors.BorrowerRequired();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        _prepareForPayment(borrower, poolConfig.receivableAsset(), receivableId);

        (amountPaid, paidoff) = _makePrincipalPayment(borrower, creditHash, amount);

        emit PrincipalPaymentMadeWithReceivable(borrower, receivableId, amount, msg.sender);
    }

    /**
     * @notice Allows the borrower to payback the principal with a receivable and drawdown at the same time with
     * another receivable
     */
    function makePrincipalPaymentAndDrawdownWithReceivable(
        address borrower,
        uint256 paymentReceivableId,
        uint256 paymentAmount,
        uint256 drawdownReceivableId,
        uint256 drawdownAmount
    ) public virtual returns (uint256 amountPaid, uint256 netAmountToBorrower, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) revert Errors.BorrowerRequired();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);
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
        _prepareForPayment(borrower, receivableAsset, paymentReceivableId);
        _prepareForDrawdown(
            borrower,
            creditHash,
            receivableAsset,
            drawdownReceivableId,
            drawdownAmount
        );

        if (paymentAmount == drawdownAmount) {
            poolSafe.deposit(msg.sender, paymentAmount);
            poolSafe.withdraw(borrower, paymentAmount);
        } else if (paymentAmount > drawdownAmount) {
            poolSafe.deposit(msg.sender, drawdownAmount);
            poolSafe.withdraw(borrower, drawdownAmount);

            uint256 amount = paymentAmount - drawdownAmount;
            (amountPaid, paidoff) = _makePrincipalPayment(borrower, creditHash, amount);
        } else {
            // paymentAmount < drawdownAmount
            poolSafe.deposit(msg.sender, paymentAmount);
            poolSafe.withdraw(borrower, paymentAmount);
            uint256 amount = drawdownAmount - paymentAmount;
            netAmountToBorrower = _drawdown(borrower, creditHash, amount);
        }

        emit PrincipalPaymentMadeWithReceivable(
            borrower,
            paymentReceivableId,
            paymentAmount,
            msg.sender
        );

        emit DrawdownMadeWithReceivable(
            borrower,
            drawdownReceivableId,
            drawdownAmount,
            msg.sender
        );
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
        rbclManager.decreaseCreditLimit(creditHash, amount);

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

    function getCreditHash(address borrower) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }
}
