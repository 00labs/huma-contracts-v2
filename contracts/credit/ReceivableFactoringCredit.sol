// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {IERC721, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {Credit} from "./Credit.sol";
import {CreditRecord, DueDetail} from "./CreditStructs.sol";
import {IReceivableFactoringCredit} from "./interfaces/IReceivableFactoringCredit.sol";
import {IReceivablePayable} from "./interfaces/IReceivablePayable.sol";
import {IReceivableFactoringCreditManager} from "./interfaces/IReceivableFactoringCreditManager.sol";
import {Errors} from "../common/Errors.sol";

contract ReceivableFactoringCredit is
    ERC165Upgradeable,
    Credit,
    IERC721Receiver,
    IReceivableFactoringCredit,
    IReceivablePayable
{
    bytes32 public constant PAYER_ROLE = keccak256("PAYER");

    /**
     * @notice The funds not used for payment has been disbursed to the receiver. This happens when
     * the payer paid more than the payoff amount of the credit.
     * @param receiver The receiver of the funds being disbursed.
     * @param amount The amount disbursed.
     */
    event ExtraFundsDisbursed(address indexed receiver, uint256 amount);

    /**
     * @notice A borrowing event has happened to the credit.
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

    /**
     * @notice A payment has been made against the credit.
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

    /// @inheritdoc IReceivableFactoringCredit
    function drawdownWithReceivable(
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 netAmountToBorrower) {
        poolConfig.onlyProtocolAndPoolOn();
        if (receivableId == 0) revert Errors.ZeroReceivableIdProvided();

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        if (receivableAsset.ownerOf(receivableId) != msg.sender)
            revert Errors.ReceivableOwnerRequired();

        bytes32 creditHash = getCreditHash(receivableId);
        creditManager.onlyCreditBorrower(creditHash, msg.sender);

        receivableAsset.safeTransferFrom(msg.sender, address(this), receivableId);

        netAmountToBorrower = _drawdown(msg.sender, creditHash, amount);

        emit DrawdownMadeWithReceivable(msg.sender, receivableId, amount, msg.sender);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function makePaymentWithReceivable(
        uint256 receivableId,
        uint256 amount
    ) external virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (receivableId == 0) revert Errors.ZeroReceivableIdProvided();

        bytes32 creditHash = getCreditHash(receivableId);
        creditManager.onlyCreditBorrower(creditHash, msg.sender);

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        if (receivableAsset.ownerOf(receivableId) != address(this))
            revert Errors.ReceivableOwnerRequired();

        (amountPaid, paidoff) = _makePaymentWithReceivable(msg.sender, creditHash, amount);
        emit PaymentMadeWithReceivable(msg.sender, receivableId, amount, msg.sender);
    }

    function onERC721Received(
        address /*operator*/,
        address /*from*/,
        uint256 /*tokenId*/,
        bytes calldata /*data*/
    ) external virtual returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @inheritdoc IReceivablePayable
    function makePaymentWithReceivableByPayer(
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (receivableId == 0) revert Errors.ZeroReceivableIdProvided();

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        if (receivableAsset.ownerOf(receivableId) != address(this))
            revert Errors.ReceivableOwnerRequired();

        bytes32 creditHash = getCreditHash(receivableId);
        // Restrict access to only payers to prevent money laundering.
        address borrower = IReceivableFactoringCreditManager(address(creditManager)).onlyPayer(
            msg.sender,
            creditHash
        );

        (amountPaid, paidoff) = _makePaymentWithReceivable(borrower, creditHash, amount);
        emit PaymentMadeWithReceivable(borrower, receivableId, amount, msg.sender);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function getNextBillRefreshDate(
        uint256 receivableId
    ) external view returns (uint256 refreshDate) {
        bytes32 creditHash = getCreditHash(receivableId);
        return _getNextBillRefreshDate(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function getDueInfo(
        uint256 receivableId
    ) external view returns (CreditRecord memory cr, DueDetail memory dd) {
        bytes32 creditHash = getCreditHash(receivableId);
        return _getDueInfo(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function getCreditRecord(uint256 receivableId) external view returns (CreditRecord memory) {
        bytes32 creditHash = getCreditHash(receivableId);
        return getCreditRecord(creditHash);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IReceivablePayable).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function getCreditHash(uint256 receivableId) public view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), poolConfig.receivableAsset(), receivableId));
    }

    function _makePaymentWithReceivable(
        address borrower,
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff) {
        (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);
        if (amount > amountPaid && msg.sender != borrower) {
            // If the payer paid more than the payoff amount, then disburse the remaining amount
            // to the borrower.
            uint256 disbursedAmount = amount - amountPaid;
            poolSafe.deposit(msg.sender, disbursedAmount);
            poolSafe.withdraw(borrower, disbursedAmount);
            emit ExtraFundsDisbursed(borrower, disbursedAmount);
        }

        // Don't delete the paid receivable.
    }
}
