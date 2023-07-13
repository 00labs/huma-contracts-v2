// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord} from "./CreditStructs.sol";
import {PoolConfig} from "../PoolConfig.sol";

contract BaseCreditStorage {
    uint256 public totalAccruedProfit;
    uint256 public totalAccruedLoss;
    uint256 public totalAccruedLossRecovery;

    /// mapping from borrower to the credit limit at borrower-level
    mapping(address => uint96) internal _borrowerCreditLimitMap;
    /// mapping from credit id to the credit config
    mapping(bytes32 => CreditConfig) internal _creditConfigMap;
    /// mapping from credit id to the credit record
    mapping(bytes32 => CreditRecord) internal _creditRecordMap;

    bytes32[] public activeCreditsHash;
    bytes32[] public overdueCreditsHash;

    PoolConfig internal _poolConfig;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
