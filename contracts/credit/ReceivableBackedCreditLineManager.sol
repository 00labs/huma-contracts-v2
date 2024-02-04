// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditLineManager} from "./CreditLineManager.sol";
import {ReceivableBackedCreditLineManagerStorage} from "./ReceivableBackedCreditLineManagerStorage.sol";
import {CreditConfig, ReceivableInfo, ReceivableState} from "./CreditStructs.sol";
import {Errors} from "../common/Errors.sol";
import {IReceivableBackedCreditLineManager} from "./interfaces/IReceivableBackedCreditLineManager.sol";
import {HUNDRED_PERCENT_IN_BPS} from "../common/SharedDefs.sol";
import {IReceivable} from "./interfaces/IReceivable.sol";
import {PoolConfig} from "../common/PoolConfig.sol";
import {CreditManager} from "./CreditManager.sol";

contract ReceivableBackedCreditLineManager is
    IReceivableBackedCreditLineManager,
    CreditLineManager,
    ReceivableBackedCreditLineManagerStorage
{
    /**
     * @notice A receivable has been approved and may be used for future drawdown.
     * @param borrower The address of the borrower.
     * @param receivableId The ID of the receivable.
     * @param receivableAmount The amount of the receivable.
     * @param incrementalCredit The incremental amount of credit available for drawdown
     * due to the approval of the receivable.
     * @param availableCredit The updated total amount of credit available for drawdown.
     */
    event ReceivableApproved(
        address borrower,
        uint256 receivableId,
        uint256 receivableAmount,
        uint256 incrementalCredit,
        uint256 availableCredit
    );

    /// @inheritdoc IReceivableBackedCreditLineManager
    function approveReceivable(address borrower, uint256 receivableId) external {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != humaConfig.eaServiceAccount() && msg.sender != address(credit))
            revert Errors.AuthorizedContractCallerRequired();

        if (receivableId == 0) revert Errors.ZeroReceivableIdProvided();
        address existingBorrowerForReceivable = receivableBorrowers[receivableId];
        if (existingBorrowerForReceivable == borrower) {
            // If a receivable has been previously approved, then early return so that the operation
            // is idempotent. This makes it possible for a manually approved receivable to be used
            // for drawdown in a pool that has receivable auto-approval.
            return;
        }
        if (existingBorrowerForReceivable != address(0)) {
            // Revert if the receivable was previously approved but belongs to some other borrower.
            revert Errors.ReceivableIdMismatch();
        }
        ReceivableInfo memory receivable = receivableAsset.getReceivable(receivableId);
        // Either the receivable does not exist, or the receivable has a zero amount.
        // We shouldn't approve either way.
        if (receivable.receivableAmount == 0) revert Errors.ZeroReceivableAmount();
        validateReceivableStatus(receivable.maturityDate, receivable.state);

        bytes32 creditHash = getCreditHash(borrower);
        onlyCreditBorrower(creditHash, borrower);

        _approveReceivable(borrower, creditHash, receivableId, receivable.receivableAmount);
    }

    /// @inheritdoc IReceivableBackedCreditLineManager
    function decreaseCreditLimit(bytes32 creditHash, uint256 amount) external {
        if (msg.sender != address(credit)) revert Errors.AuthorizedContractCallerRequired();
        uint256 availableCredit = availableCredits[creditHash];
        if (amount > availableCredit) revert Errors.CreditLimitExceeded();
        availableCredit -= amount;
        availableCredits[creditHash] = uint96(availableCredit);
    }

    /// @inheritdoc IReceivableBackedCreditLineManager
    function validateReceivableOwnership(address borrower, uint256 receivableId) external view {
        if (receivableBorrowers[receivableId] != borrower) revert Errors.ReceivableIdMismatch();
    }

    /// @inheritdoc IReceivableBackedCreditLineManager
    function getAvailableCredit(address borrower) external view returns (uint256 availableCredit) {
        bytes32 creditHash = getCreditHash(borrower);
        return availableCredits[creditHash];
    }

    /// @inheritdoc IReceivableBackedCreditLineManager
    function validateReceivableStatus(uint256 maturityDate, ReceivableState state) public view {
        if (maturityDate < block.timestamp) revert Errors.ReceivableAlreadyMatured();
        if (state != ReceivableState.Minted && state != ReceivableState.Approved)
            revert Errors.InvalidReceivableState();
    }

    function _approveReceivable(
        address borrower,
        bytes32 creditHash,
        uint256 receivableId,
        uint256 receivableAmount
    ) internal {
        CreditConfig memory cc = getCreditConfig(creditHash);
        uint256 availableCredit = availableCredits[creditHash];

        uint256 incrementalCredit = (cc.advanceRateInBps * receivableAmount) /
            HUNDRED_PERCENT_IN_BPS;
        availableCredit += incrementalCredit;
        if (availableCredit > cc.creditLimit) {
            revert Errors.CreditLimitExceeded();
        }
        availableCredits[creditHash] = uint96(availableCredit);

        receivableBorrowers[receivableId] = borrower;

        emit ReceivableApproved(
            borrower,
            receivableId,
            receivableAmount,
            incrementalCredit,
            availableCredit
        );
    }

    function _updatePoolConfigData(PoolConfig poolConfig) internal virtual override {
        CreditManager._updatePoolConfigData(poolConfig);

        address addr = address(poolConfig.receivableAsset());
        assert(addr != address(0));
        receivableAsset = IReceivable(addr);
    }
}
