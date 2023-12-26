// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC721, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Credit} from "./Credit.sol";
import {ReceivableInput} from "./CreditStructs.sol";
import {CreditRecord, CreditState, DueDetail} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";
import {IReceivableBackedCreditLineManager} from "./interfaces/IReceivableBackedCreditLineManager.sol";

import "hardhat/console.sol";

contract ReceivableBackedCreditLine is Credit, IERC721Receiver {
    event PrincipalPaymentWithReceivableMade(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 amount,
        address by
    );

    event PaymentWithReceivableMade(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 amount,
        address by
    );

    event DrawdownWithReceivableMade(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 receivableAmount,
        uint256 amount,
        address by
    );

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
        ReceivableInput memory receivableInput,
        uint256 amount
    ) public virtual {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) revert Errors.notBorrower();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        _prepareForDrawdown(
            borrower,
            creditHash,
            IERC721(poolConfig.receivableAsset()),
            receivableInput,
            amount
        );
        _drawdown(borrower, creditHash, amount);

        emit DrawdownWithReceivableMade(
            borrower,
            receivableInput.receivableId,
            receivableInput.receivableAmount,
            amount,
            msg.sender
        );
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
        if (msg.sender != borrower) _onlyPDSServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        _prepareForPayment(borrower, IERC721(poolConfig.receivableAsset()), receivableId);
        // todo update the receivable to indicate it is paid.

        (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);

        emit PaymentWithReceivableMade(borrower, receivableId, amount, msg.sender);
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
        // TODO(jiatu): PDS account?
        if (msg.sender != borrower) revert Errors.notBorrower();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        _prepareForPayment(borrower, receivableAsset, receivableId);

        (amountPaid, paidoff) = _makePrincipalPayment(borrower, creditHash, amount);

        emit PrincipalPaymentWithReceivableMade(borrower, receivableId, amount, msg.sender);
    }

    /**
     * @notice Allows the borrower to payback the principal with a receivable and drawdown at the same time with
     * another receivable
     */
    function makePrincipalPaymentAndDrawdownWithReceivable(
        address borrower,
        uint256 paymentReceivableId,
        uint256 paymentAmount,
        ReceivableInput memory drawdownReceivableInput,
        uint256 drawdownAmount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) revert Errors.notBorrower();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);
        if (getCreditRecord(creditHash).state != CreditState.GoodStanding)
            revert Errors.creditLineNotInStateForMakingPrincipalPayment();

        if (drawdownAmount == 0 || paymentAmount == 0) revert Errors.zeroAmountProvided();

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        _prepareForPayment(borrower, receivableAsset, paymentReceivableId);
        _prepareForDrawdown(
            borrower,
            creditHash,
            receivableAsset,
            drawdownReceivableInput,
            drawdownAmount
        );

        // TODO(jiatu): What if there is no principal in the first place?
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
            _drawdown(borrower, creditHash, amount);
        }

        emit PrincipalPaymentWithReceivableMade(
            borrower,
            paymentReceivableId,
            paymentAmount,
            msg.sender
        );

        emit DrawdownWithReceivableMade(
            borrower,
            drawdownReceivableInput.receivableId,
            drawdownReceivableInput.receivableAmount,
            drawdownAmount,
            msg.sender
        );
    }

    function onERC721Received(
        address /*operator*/,
        address /*from*/,
        uint256 /*tokenId*/,
        bytes calldata /*data*/
    ) external virtual returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function _prepareForPayment(
        address borrower,
        IERC721 receivableAsset,
        uint256 receivableId
    ) internal view {
        if (receivableId == 0) revert Errors.zeroReceivableIdProvided();
        IReceivableBackedCreditLineManager(address(creditManager)).validateReceivable(
            borrower,
            receivableId
        );
        if (receivableAsset.ownerOf(receivableId) != address(this))
            revert Errors.notReceivableOwner();
    }

    function _prepareForDrawdown(
        address borrower,
        bytes32 creditHash,
        IERC721 receivableAsset,
        ReceivableInput memory receivableInput,
        uint256 amount
    ) internal {
        // TODO: Check amount < receivable amount?
        if (receivableInput.receivableAmount == 0) revert Errors.zeroAmountProvided();
        if (receivableInput.receivableId == 0) revert Errors.zeroReceivableIdProvided();
        if (receivableAsset.ownerOf(receivableInput.receivableId) != borrower)
            revert Errors.notReceivableOwner();

        IReceivableBackedCreditLineManager rbclManager = IReceivableBackedCreditLineManager(
            address(creditManager)
        );
        if (_getCreditConfig(creditHash).autoApproval) {
            rbclManager.approveReceivable(borrower, receivableInput);
        } else {
            rbclManager.validateReceivable(borrower, receivableInput.receivableId);
        }
        rbclManager.decreaseCreditLimit(creditHash, amount);

        receivableAsset.safeTransferFrom(borrower, address(this), receivableInput.receivableId);
    }

    function getCreditHash(address borrower) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }
}
